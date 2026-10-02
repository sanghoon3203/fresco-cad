import { createServer } from 'node:http';
import { readFile, writeFile, readdir, realpath, mkdir, copyFile, rename, unlink, open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { previewServer } from './serve.mjs';
import { readJww, hash, fail, patchLine, verifyLineEdit, observeRules } from '../native/jww.mjs';
import { generateRules, classifyLayers, generateArchitecture } from '../ai/providers.mjs';
import { toIR, translate } from '../native/jww-pipeline.mjs';
import { architecturalSkills, prepareArchitectureSkill, validateArchitectureResult } from '../ai/architecture-skills.mjs';
import { decodeJww, semanticView } from '../native/codec/jww-codec.mjs';
import { flattenDrawing } from '../native/render/flatten.mjs';
import { validatePatchV2 } from '../core/patch-v2.mjs';
import { checkLayers, checkPatchLayers, applyLayerCorrections, roleFromName, ROLES } from '../core/layer-profile.mjs';
import { applyPatchV2 } from '../native/jww-edit.mjs';
import { runEdit } from '../ai/edit-loop.mjs';
import { loadSettings, saveSettings, defaultSettingsPath } from '../ai/settings.mjs';
import { createMockProvider } from '../eval/mock.mjs';

// ---- Studio v2 helpers (pure; exported for tests) --------------------------------------------------------------------
const KNOWLEDGE = new URL('../knowledge/', import.meta.url);
const UI_ROOT = new URL('../ui/', import.meta.url);
const round4 = v => Math.round(v * 1e4) / 1e4;
const KIND_CODE = { line: 0, poly: 1, point: 2, solid: 3, text: 4 };
const isAutoSave = name => /\.jw\$/iu.test(name) || /【自動保存】/u.test(name);

async function readJsonFile(url) { try { return JSON.parse(await readFile(url, 'utf8')); } catch { return null; } }

/** Paper-mm scene for the canvas: flattened primitives (blocks expanded) tagged with their top-level entity index. */
export function buildScene(bytes, { profile = null, rules = null, sourceHash = hash(bytes) } = {}) {
  const doc = decodeJww(bytes), view = semanticView(doc);
  const layerIndex = new Map(view.layers.map((l, i) => [l.id, i])), counts = new Map();
  const ents = [], prims = [];
  let bbox = null;
  const grow = b => { if (!b) return; bbox = bbox ? [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]), Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])] : [...b]; };
  view.entities.forEach((e, i) => {
    let flat;
    try { flat = flattenDrawing({ entities: [e], blocks: e.kind === 'block' ? view.blocks : [] }); } catch { flat = { primitives: [], bbox: null }; }
    const l = layerIndex.get(e.layer) ?? 0;
    counts.set(e.layer, (counts.get(e.layer) ?? 0) + 1);
    ents.push({ id: e.id, k: e.kind, l, c: e.pen?.color ?? 0, s: e.pen?.style ?? 0, w: e.pen?.width ?? 0, b: flat.bbox?.map(round4) ?? null, ...(e.name ? { n: e.name } : {}) });
    grow(flat.bbox);
    for (const p of flat.primitives) prims.push(encodePrim(p, i, layerIndex));
  });
  const lite = liteIR(doc, view, sourceHash);
  let check = null;
  if (profile) { try { check = checkLayers(lite, profile); } catch (error) { check = { error: error.code ?? 'E_LAYER_CHECK' }; } }
  const perLayer = new Map();
  for (const f of check?.findings ?? []) {
    const c = perLayer.get(f.layerId) ?? { error: 0, warning: 0, info: 0 };
    c[f.severity] = (c[f.severity] ?? 0) + (f.count || 1); perLayer.set(f.layerId, c);
  }
  const layers = view.layers.map(l => {
    const named = roleFromName(l.name, l.groupName), prof = profile?.layers?.[l.id];
    let role = null, roleSource = null;
    if (named?.role && named.role !== 'unknown') { role = named.role; roleSource = 'name'; }
    else if (prof?.role && prof.role !== 'unknown' && prof.confidence >= 0.5) { role = prof.role; roleSource = 'profile'; }
    const rule = rules?.layers?.[l.id];
    return { id: l.id, name: l.name ?? '', groupName: l.groupName ?? '', scale: l.scale, state: l.state, count: counts.get(l.id) ?? 0,
      role, roleJa: role ? ROLES[role]?.ja ?? null : null, roleSource, ruleJa: rule?.ja ?? null, check: perLayer.get(l.id) ?? null };
  });
  const findings = (check?.findings ?? []).slice(0, 400).map(f => ({ id: f.id, ruleId: f.ruleId, severity: f.severity, layerId: f.layerId,
    entityIds: f.entityIds.slice(0, 500), count: f.count, ja: f.message_ja, ko: f.message_ko }));
  return { scene: { schema: 'fresco-studio-scene/1', sourceHash, version: view.version, units: 'paper-mm', bbox: bbox?.map(round4) ?? null,
    layers, ents, prims, check: check ? { summary: check.summary ?? null, findings, error: check.error ?? null } : null,
    partial: !!view.partial }, lite, view };
}
function encodePrim(p, e, layerIndex) {
  const out = { e, t: KIND_CODE[p.t] ?? 0, l: layerIndex.get(p.layer) ?? 0, c: p.color ?? 0, p: p.pts.flat().map(round4) };
  if (p.t !== 'solid' && p.t !== 'text') { out.s = p.style ?? 1; if (p.width) out.w = p.width; }
  if (p.t === 'solid' && p.rgb !== null && p.rgb !== undefined) out.rgb = p.rgb;
  if (p.t === 'text') Object.assign(out, { tx: p.text ?? '', h: round4(p.height), wd: round4(p.width), a: round4(p.angle ?? 0) });
  return out;
}
/** Minimal IR (ids, layers, props, paper geometry) for Patch v2 validation and layer checks, built from the fast codec. */
export function liteIR(doc, view, sourceHash) {
  const entities = doc.entities.map(e => {
    const g = e.geometry, kind = e.kind;
    const geometry = kind === 'line' ? { kind: 'line', start: g.start, end: g.end } : kind === 'text' ? { kind: 'text', anchor: g.at, text: g.text, height: g.height } : null;
    return { id: e.id, type: e.type, layerId: e.layer, sourceProperties: e.props, geometry };
  });
  return { schemaVersion: 2, sourceHash, layers: view.layers.map(({ id, name, groupName, scale, state }) => ({ id, name, groupName, scale, state })), entities };
}
/** Geometry-signature diff between two scenes: removed (before indices), added (after entities + prims), moves for translate ops. */
export function diffScenes(before, after, ops = []) {
  const sig = scene => { const by = new Map(); for (const p of scene.prims) (by.get(p.e) ?? by.set(p.e, []).get(p.e)).push(p); return by; };
  const key = (ent, prims) => JSON.stringify([ent.k, ent.l, ent.c, ent.s, ent.w, (prims ?? []).map(p => [p.t, p.c, p.p, p.tx ?? null, p.h ?? null])]);
  const bp = sig(before), ap = sig(after), pool = new Map();
  before.ents.forEach((ent, i) => { const k = key(ent, bp.get(i)); (pool.get(k) ?? pool.set(k, []).get(k)).push(i); });
  const addedIdx = [];
  after.ents.forEach((ent, i) => { const k = key(ent, ap.get(i)), list = pool.get(k); if (list?.length) list.pop(); else addedIdx.push(i); });
  const removed = [...pool.values()].flat().sort((a, b) => a - b);
  const remap = new Map(addedIdx.map((ai, j) => [ai, j]));
  const added = { ents: addedIdx.map(i => after.ents[i]), prims: after.prims.filter(p => remap.has(p.e)).map(p => ({ ...p, e: remap.get(p.e) })) };
  const scaleOf = (scene, ent) => scene.layers[ent.l]?.scale || 1;
  const centre = b => b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null;
  const moves = [], used = new Set(), byId = new Map(before.ents.map((e, i) => [e.id, i]));
  for (const op of ops) {
    if (op.op !== 'translate') continue;
    for (const id of op.ids) {
      const bi = byId.get(id); if (bi === undefined || !removed.includes(bi)) continue;
      const be = before.ents[bi], s = scaleOf(before, be), d = [op.dx / s, op.dy / s], c = centre(be.b);
      if (!c) continue;
      let best = -1, bestDist = 0.05 + Math.hypot(...d) * 1e-6;
      added.ents.forEach((ae, j) => {
        if (used.has(j) || ae.k !== be.k) return;
        const ac = centre(ae.b); if (!ac) return;
        const dist = Math.hypot(ac[0] - c[0] - d[0], ac[1] - c[1] - d[1]);
        if (dist < bestDist) { best = j; bestDist = dist; }
      });
      if (best >= 0) { used.add(best); moves.push({ from: bi, to: best, d: d.map(round4) }); }
    }
  }
  let bbox = null;
  const grow = b => { if (b) bbox = bbox ? [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]), Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])] : [...b]; };
  removed.forEach(i => grow(before.ents[i].b)); added.ents.forEach(e => grow(e.b));
  return { removed, added, moves, bbox };
}

/**
 * Offline demo provider: understands "move N in a direction", "delete" and "move to layer G:L" for the current selection
 * (Japanese / Korean / English), and asks a clarification question otherwise. Never leaves the machine.
 */
export function mockEditScript({ selection = [], layers = [] } = {}) {
  return ({ sourceHash, instruction }) => {
    const text = String(instruction).normalize('NFKC'), ko = /[\uac00-\ud7a3]/u.test(text), en = !ko && !/[\u3040-\u30ff\u4e00-\u9fff]/u.test(text);
    const say = (ja, k, e) => (ko ? k : en ? e : ja);
    const base = { schemaVersion: 2, sourceHash, units: 'model-mm', needsClarification: null };
    const ask = q => ({ ...base, ops: [], rationale: 'mock', needsClarification: q });
    if (/広げ|拡げ|大きく|넓|늘려|키워|widen|enlarge|bigger/iu.test(text)) return ask(say('どのくらい広げますか？（例：両側に455mmずつ）', '얼마나 넓힐까요? (예: 양쪽으로 455mm씩)', 'How much wider? (e.g. 455 mm on each side)'));
    if (!selection.length) return ask(say('対象が特定できません。図面で要素を選択してから指示してください。', '대상을 특정할 수 없습니다. 도면에서 요소를 선택한 뒤 지시해 주세요.', 'Which element? Select it on the drawing first.'));
    if (/削除|消して|消す|除去|삭제|지워|없애|delete|remove|erase/iu.test(text)) return { ...base, ops: [{ op: 'delete', ids: selection }], rationale: say(`選択中の${selection.length}要素を削除`, `선택한 ${selection.length}개 요소 삭제`, `Delete ${selection.length} selected element(s)`) };
    const layer = /\b([0-9A-F])\s*[:：]\s*([0-9A-F])\b/iu.exec(text);
    if (layer && /レイヤ|레이어|layer/iu.test(text)) {
      const id = `${layer[1].toUpperCase()}:${layer[2].toUpperCase()}`;
      if (!layers.includes(id)) return ask(say(`レイヤ ${id} は存在しません。`, `레이어 ${id}가 없습니다.`, `Layer ${id} does not exist.`));
      return { ...base, ops: [{ op: 'setLayer', ids: selection, layer: id }], rationale: say(`レイヤ ${id} へ移動`, `레이어 ${id}로 이동`, `Move to layer ${id}`) };
    }
    const dirs = [[/右|みぎ|오른|우측|right|東/iu, [1, 0]], [/左|ひだり|왼|좌측|left|西/iu, [-1, 0]], [/上|うえ|위로|위쪽|\bup\b|北/iu, [0, 1]], [/下|した|아래|\bdown\b|南/iu, [0, -1]]];
    const dir = dirs.find(([re]) => re.test(text))?.[1];
    const amount = /(\d+(?:[.,]\d+)*)/u.exec(text.replace(/\b[0-9A-F]\s*:\s*[0-9A-F]\b/giu, ''));
    const value = amount ? Number(amount[1].replace(/,/gu, '')) : NaN;
    if (dir && Number.isFinite(value) && value > 0 && value < 1e6) {
      return { ...base, ops: [{ op: 'translate', ids: selection, dx: dir[0] * value, dy: dir[1] * value }],
        rationale: say(`選択中の${selection.length}要素を${value}mm移動`, `선택한 ${selection.length}개 요소를 ${value}mm 이동`, `Move ${selection.length} element(s) by ${value} mm`) };
    }
    if (dir) return ask(say('何mm移動しますか？', '몇 mm 이동할까요?', 'How many millimetres?'));
    return ask(say('デモ（モック）では「910右へ」「削除」「レイヤ 0:3 へ」を試せます。', '데모(모의)에서는 "910 오른쪽으로", "삭제", "레이어 0:3으로"를 시험할 수 있습니다.', 'The mock understands "move 910 right", "delete" and "to layer 0:3".'));
  };
}

const STUDIO_ASSETS = new Map([
  ['/ui/motion.mjs', 'motion.mjs'], ['/ui/studio/i18n.mjs', 'studio/i18n.mjs'], ['/ui/studio/toast.mjs', 'studio/toast.mjs'],
  ['/ui/studio/ops.mjs', 'studio/ops.mjs'], ['/ui/studio/sheet.mjs', 'studio/sheet.mjs']
]);
const GET_ROUTES = new Set(['/api/bootstrap', '/api/status', '/api/v2/bootstrap', '/api/v2/files', '/api/v2/scene', '/api/v2/entity', '/api/v2/settings', '/api/v2/generator']);
const MIME = { '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8' };
async function serveAsset(req, res, address, pathname) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', STUDIO_CSP);
  if (req.headers.host !== address || (req.headers.origin && req.headers.origin !== `http://${address}`)) { res.writeHead(403); return res.end(); }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
  try {
    const data = await readFile(new URL(STUDIO_ASSETS.get(pathname), UI_ROOT));
    res.setHeader('Content-Type', MIME[path.extname(pathname)] ?? 'application/octet-stream'); res.setHeader('Content-Length', data.length);
    res.writeHead(200); res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end(); }
}
/** Model-mm details of one top-level entity for the inspector. */
export function entityDetails(e, layer) {
  const k = layer?.scale || 1, r = v => Math.round(v * 1000) / 1000, m = q => q && [r(q[0] * k), r(q[1] * k)], g = e.geometry ?? {}, deg = v => r((v ?? 0) * 180 / Math.PI);
  const base = { id: e.id, kind: e.kind, type: e.type, layer: { id: e.layer, name: layer?.name ?? '', groupName: layer?.groupName ?? '', scale: k }, pen: e.pen };
  switch (e.kind) {
    case 'line': return { ...base, start: m(g.start), end: m(g.end), length: r(Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1]) * k), editable: ['start', 'end'] };
    case 'arc': return { ...base, center: m(g.center), radius: r(g.radius * k), startAngle: deg(g.startRadians), sweepAngle: g.full ? 360 : deg(g.sweepRadians), flatness: g.flatness, full: g.full, editable: ['center', 'radius'] };
    case 'text': return { ...base, at: m(g.at), text: g.text, height: g.height, width: g.width, spacing: g.spacing, angle: g.angleDegrees, style: g.style, font: g.font, editable: ['at', 'text', 'height'] };
    case 'point': return { ...base, at: m(g.at), editable: ['at'] };
    case 'solid': return { ...base, points: (g.points ?? []).map(m), editable: [] };
    case 'block': return { ...base, at: m(g.at), name: e.name ?? null, number: g.number, scaleX: g.scaleX, scaleY: g.scaleY, rotation: deg(g.rotationRadians), editable: [] };
    case 'dimension': return { ...base, start: m(g.line?.start), end: m(g.line?.end), text: g.text?.text ?? '', editable: [] };
    default: return { ...base, editable: [] };
  }
}
const STUDIO_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

export async function studioServer({ drawingRoot = process.env.FRESCO_DRAWING_ROOT,
  workRoot = path.join(process.env.LOCALAPPDATA ?? process.cwd(), 'FrescoAssistant', 'drawings'),
  jwExe = process.env.FRESCO_JW_EXE ?? 'C:\\jww\\Jw_win.exe',
  aiFetch = fetch, settingsFile = defaultSettingsPath(), env = process.env, knowledgeDir = KNOWLEDGE } = {}) {
  const token = randomBytes(32).toString('hex'), sessions = new Map(), files = new Map(), studio = new Map();
  let mutationBusy = false, aiBusy = false;
  const profile = await readJsonFile(new URL('office-layer-profile.json', knowledgeDir));
  const rules = await readJsonFile(new URL('office-drafting-rules.json', knowledgeDir));
  let generator = null;
  try { generator = await import('../generator/draw-plan.mjs'); if (typeof generator.drawPlan !== 'function') generator = null; } catch { generator = null; }
  const credentials = { openai: process.env.OPENAI_API_KEY ?? '', typesafe: process.env.TYPESAFE_API_KEY ?? '', model: process.env.OPENAI_MODEL ?? '', jevModel: 'jev-1.13.0' };
  const staticHandler = previewServer().listeners('request')[0];
  const root = drawingRoot ? await realpath(drawingRoot) : null;
  await mkdir(workRoot, { recursive: true }); workRoot = await realpath(workRoot);
  async function listFiles() {
    files.clear();
    let scanned = 0;
    async function walk(folder) {
      if (++scanned > 1000 || files.size >= 200) return;
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.jww' && !isAutoSave(entry.name)) {
          const resolved = await realpath(full), relative = path.relative(root, resolved);
          if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
          files.set(hash(Buffer.from(relative)).slice(0, 24), { path: resolved, name: relative });
          if (files.size >= 200) break;
        }
      }
    }
    if (root) await walk(root);
    for (const entry of await readdir(workRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jww')) {
        files.set(hash(Buffer.from(`work:${entry.name}`)).slice(0, 24), { path: path.join(workRoot, entry.name), name: `[作業コピー] ${entry.name}`, working: true });
      }
    }
    return [...files].map(([id, value]) => ({ id, name: value.name }));
  }
  function session(id) { const result = sessions.get(id); if (!result) fail('E_SESSION_MISSING'); return result; }
  function snapshot(value) {
    return { id: value.id, name: path.basename(value.path), workPath: value.path, hash: value.hash,
      ir: value.ir ??= toIR(value.bytes, value.document),
      rules: observeRules(value.document, value.hash), adoptedRules: value.adoptedRules ?? [] };
  }
  async function load(value) {
    const bytes = await readFile(value.path); const document = await readJww(bytes);
    value.bytes = bytes; value.hash = hash(bytes); value.document = document; value.ir = null; value.preview = null; return value;
  }
  async function current(value, baseHash) {
    if (baseHash !== value.hash || hash(await readFile(value.path)) !== value.hash) fail('E_JWW_EXTERNAL_CHANGE');
  }
  async function preview(value, patch) {
    const translated = translate(value.bytes, value.document, patch);
    const document = await readJww(translated.bytes);
    verifyLineEdit(translated.expected, document, null, []);
    await current(value, patch.sourceHash);
    const after = toIR(translated.bytes, document), before = value.ir ??= toIR(value.bytes, value.document);
    const changes = patch.ids.map(id => ({ id, before: before.entities.find(e => e.id === id).points, after: after.entities.find(e => e.id === id).points }));
    const summary = { id: randomUUID(), sourceHash: value.hash, outputHash: hash(translated.bytes), patch, changes,
      nativeReparse: true, jwcadVisualVerified: false };
    value.preview = { summary, bytes: translated.bytes, document, ir: after };
    return summary;
  }
  async function bodyOf(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) fail('E_CONTENT_TYPE');
    const chunks = []; let size = 0;
    const limit = ['/api/v2/generate', '/api/v2/patch'].includes(req.url.split('?')[0]) ? 512 * 1024 : 100000;
    for await (const chunk of req) { size += chunk.length; if (size > limit) fail('E_REQUEST_LIMIT'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('E_REQUEST_JSON'); }
  }
  async function route(req, url, data) {
    if (url.pathname === '/api/bootstrap' && req.method === 'GET') return { token, files: await listFiles(), rootConfigured: !!root,
      openaiConfigured: !!credentials.openai, typesafeConfigured: !!credentials.typesafe, model: credentials.model, jevModel: credentials.jevModel, skills: architecturalSkills };
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const value = session(url.searchParams.get('session')); const digest = hash(await readFile(value.path)); return { changed: digest !== value.hash, hash: digest };
    }
    if (url.pathname === '/api/open') {
      if (sessions.size >= 8) fail('E_SESSION_LIMIT');
      const file = files.get(data.fileId); if (!file) fail('E_FILE_SELECTION');
      const info = await stat(file.path); if (info.size > 32 * 1024 * 1024) fail('E_JWW_SIZE');
      const bytes = await readFile(file.path), document = await readJww(bytes), id = randomUUID();
      const target = file.working ? file.path : path.join(workRoot, `${path.basename(file.path, path.extname(file.path)).slice(0, 80)}-${id.slice(0, 8)}.jww`);
      if (!file.working) await writeFile(target, bytes, { flag: 'wx' });
      let adoptedRules = [];
      try {
        const stored = JSON.parse(await readFile(`${target}.rules.json`, 'utf8'));
        if (stored.schemaVersion === 1 && Array.isArray(stored.rules) && stored.rules.length <= 256
          && stored.rules.every(rule => /^[0-9A-F]:[0-9A-F]$/u.test(rule.layerId) && ['allowedColors', 'allowedStyles', 'textHeights'].every(key => Array.isArray(rule[key]) && rule[key].length <= 256 && rule[key].every(Number.isFinite)))) adoptedRules = stored.rules;
      } catch {}
      const value = { id, path: target, bytes, hash: hash(bytes), document, adoptedRules }; sessions.set(id, value); return snapshot(value);
    }
    if (url.pathname === '/api/close') { sessions.delete(data.sessionId); return { closed: true }; }
    if (url.pathname === '/api/reload') return snapshot(await load(session(data.sessionId)));
    if (url.pathname === '/api/skill-preview') {
      const value = session(data.sessionId); await current(value, data.baseHash); value.preview = null;
      if (typeof data.request !== 'string' || !data.request.trim()) fail('E_SKILL_INPUT');
      const bundle = await prepareArchitectureSkill(value.ir ??= toIR(value.bytes, value.document), {
        skillId: data.skillId, entityIds: data.entityIds, request: data.request, officeProfile: value.adoptedRules ?? []
      });
      const reply = await generateArchitecture(bundle, { key: credentials.openai, model: credentials.model, bytes: value.bytes, document: value.document, fetcher: aiFetch });
      await current(value, data.baseHash);
      validateArchitectureResult(reply.result, bundle, { bytes: value.bytes, document: value.document });
      return { ...reply, preview: reply.result.patch ? await preview(value, reply.result.patch) : null };
    }
    if (url.pathname === '/api/preview-translation') {
      const value = session(data.sessionId); await current(value, data.baseHash); value.preview = null;
      return { preview: await preview(value, { schemaVersion: 1, sourceHash: value.hash, op: 'TranslateEntities', ids: data.entityIds, dx: data.dx, dy: data.dy, units: 'model-mm' }) };
    }
    if (url.pathname === '/api/save-preview') {
      const value = session(data.sessionId); await current(value, data.baseHash);
      const pending = value.preview;
      if (!pending || pending.summary.id !== data.previewId || pending.summary.sourceHash !== value.hash) fail('E_PREVIEW_STALE');
      // Save the exact bytes already reparsed and shown in this preview, under a fresh name.
      const target = path.join(workRoot, `${path.basename(value.path, '.jww').slice(0, 80)}-edited-${randomUUID().slice(0, 8)}.jww`);
      const file = await open(target, 'wx');
      try { await file.writeFile(pending.bytes); await file.sync(); } catch (error) { await file.close(); await unlink(target).catch(() => {}); throw error; }
      await file.close();
      const receipt = pending.summary;
      value.path = target; value.bytes = pending.bytes; value.hash = receipt.outputHash; value.document = pending.document; value.ir = pending.ir; value.preview = null;
      return { ...snapshot(value), receipt, savedPath: target };
    }
    if (url.pathname === '/api/save-line') {
      const value = session(data.sessionId);
      if (data.baseHash !== value.hash || hash(await readFile(value.path)) !== value.hash) fail('E_JWW_EXTERNAL_CHANGE');
      const next = patchLine(value.bytes, value.document, data.entityId, data.points);
      const document = await readJww(next.bytes); verifyLineEdit(value.document, document, data.entityId, data.points);
      const temporary = `${value.path}.${randomUUID()}.tmp`, backup = `${value.path}.${Date.now()}.bak`;
      try {
        const file = await open(temporary, 'wx'); try { await file.writeFile(next.bytes); await file.sync(); } finally { await file.close(); }
        if (hash(await readFile(value.path)) !== value.hash) fail('E_JWW_EXTERNAL_CHANGE');
        await copyFile(value.path, backup, constants.COPYFILE_EXCL);
        if (hash(await readFile(value.path)) !== value.hash) fail('E_JWW_EXTERNAL_CHANGE');
        await rename(temporary, value.path);
      } finally { await unlink(temporary).catch(() => {}); }
      value.bytes = next.bytes; value.hash = hash(next.bytes); value.document = document; value.ir = null; value.preview = null;
      return { ...snapshot(value), backupPath: backup };
    }
    if (url.pathname === '/api/open-jw') {
      const value = session(data.sessionId); await stat(jwExe);
      await new Promise((resolve, reject) => { const child = spawn(jwExe, [value.path], { detached: true, stdio: 'ignore' }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); }); });
      return { opened: true };
    }
    if (url.pathname === '/api/adopt-rules') {
      const value = session(data.sessionId); if (data.baseHash !== value.hash) fail('E_JWW_EXTERNAL_CHANGE');
      const candidates = observeRules(value.document, value.hash).candidates;
      if (!Array.isArray(data.ids) || !data.ids.length || new Set(data.ids).size !== data.ids.length || data.ids.some(id => !candidates.some(rule => rule.id === id))) fail('E_RULE_SELECTION');
      value.adoptedRules = candidates.filter(item => data.ids.includes(item.id)).map(item => ({ ...item, status: 'user-confirmed', referenceHash: value.hash }));
      await writeFile(`${value.path}.rules.json`, JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), rules: value.adoptedRules }, null, 2));
      return { adoptedRules: value.adoptedRules };
    }
    if (url.pathname === '/api/ai-config') {
      for (const field of ['openai', 'typesafe', 'model', 'jevModel']) {
        if (data[field] !== undefined) {
          if (typeof data[field] !== 'string' || data[field].length > (field.includes('odel') ? 100 : 1000) || /[\r\n]/u.test(data[field])) fail('E_AI_CONFIG');
          credentials[field] = data[field].trim();
        }
      }
      return { openaiConfigured: !!credentials.openai, typesafeConfigured: !!credentials.typesafe, model: credentials.model, jevModel: credentials.jevModel };
    }
    if (url.pathname === '/api/ai') {
      if (aiBusy) fail('E_AI_BUSY');
      const value = session(data.sessionId);
      if (data.baseHash !== value.hash || data.confirmSend !== true || !['openai', 'typesafe'].includes(data.provider)) fail('E_AI_CONFIRM');
      // Only the exact previewed context supplied by this client is transmitted.
      aiBusy = true;
      try { return data.provider === 'openai' ? await generateRules(data.context, { key: credentials.openai, model: credentials.model })
        : await classifyLayers(data.context, { key: credentials.typesafe, model: credentials.jevModel }); }
      finally { aiBusy = false; }
    }
    if (url.pathname.startsWith('/api/v2/')) return routeV2(req, url, data);
    fail('E_NOT_FOUND');
  }

  // ---- Studio v2 ---------------------------------------------------------------------------------------------------
  const keyStatus = () => ({ claude: !!env.ANTHROPIC_API_KEY?.trim(), openai: !!env.OPENAI_API_KEY?.trim() });
  const keyFamily = provider => (provider === 'openai' ? 'openai' : 'claude');
  const settingsView = settings => ({ dataPolicy: { sendRealDrawings: settings.dataPolicy.sendRealDrawings, redactText: settings.dataPolicy.redactText,
    allowlistCount: settings.dataPolicy.allowlistHashes.length }, provider: settings.providers.default,
    models: { claude: settings.providers.claude.model, 'claude-fast': settings.providers.claude.fastModel, openai: settings.providers.openai.model },
    maxAttempts: settings.loop.maxAttempts, keys: keyStatus() });
  function v2(id) { const s = studio.get(id); if (!s) fail('E_SESSION_MISSING'); return s; }
  function setState(s, bytes, built) {
    s.bytes = bytes; s.hash = hash(bytes); s.scene = built.scene; s.lite = built.lite; s.view = built.view;
    s.ids = new Set(built.lite.entities.map(e => e.id)); s.irP = null; s.docP = null; s.pending = null;
  }
  // The DLL reader (needed by the edit loop and the apply verifier) is slow on big drawings: start it right after open.
  function docOf(s) {
    if (!s.docP) { const bytes = s.bytes; s.docP = readJww(bytes); s.docP.catch(() => { if (s.bytes === bytes) s.docP = null; }); }
    return s.docP;
  }
  function irOf(s) {
    if (!s.irP) { const bytes = s.bytes; s.irP = docOf(s).then(d => toIR(bytes, d)); s.irP.catch(() => { if (s.bytes === bytes) s.irP = null; }); }
    return s.irP;
  }
  const payload = s => ({ sessionId: s.id, name: s.name, hash: s.hash, scene: s.scene, canUndo: s.history.length > 0, savedPath: s.savedPath ?? null, working: s.working });
  async function fileList() {
    await listFiles();
    const out = [];
    for (const [id, f] of files) {
      let info = null; try { info = await stat(f.path); } catch {}
      out.push({ id, name: f.working ? path.basename(f.path) : f.name, folder: f.working ? '' : path.dirname(f.name).replace(/^\.$/u, ''), working: !!f.working,
        size: info?.size ?? null, mtime: info?.mtimeMs ?? null });
    }
    return out;
  }
  function makePreview(s, bytes, patch, normalized, outIR, checkIR) {
    const built = buildScene(bytes, { profile, rules });
    const diff = diffScenes(s.scene, built.scene, normalized.ops);
    let layerCheck = null, corrections = [];
    if (profile) {
      try {
        const r = checkPatchLayers(normalized.ops, checkIR, profile);
        corrections = r.corrections;
        layerCheck = { verdict: r.verdict, summary: r.summary,
          corrections: r.corrections.map(({ opIndex, from, to, role, reason }) => ({ opIndex, from, to, role, roleJa: ROLES[role]?.ja ?? null, reason })),
          findings: r.findings.slice(0, 50).map(f => ({ ruleId: f.ruleId, severity: f.severity, layerId: f.layerId, entityIds: f.entityIds.slice(0, 50), opIndex: f.opIndex ?? null,
            suggestedLayer: f.suggestedLayer ?? null, ja: f.message_ja, ko: f.message_ko })) };
      } catch (error) { layerCheck = { error: error.code ?? 'E_LAYER_CHECK' }; }
    }
    const id = randomUUID();
    s.pending = { id, bytes, built, ir: outIR ?? null, patch, normalized, corrections, baseHash: s.hash };
    return { previewId: id, patch, ops: normalized.ops, rationale: patch.rationale ?? '', diff, layerCheck, outputHash: hash(bytes) };
  }
  async function applyManual(s, patch) {
    if (!patch || typeof patch !== 'object') fail('E_PATCH_SCHEMA');
    const normalized = validatePatchV2(patch, s.lite);
    if (!normalized.ops.length) fail('E_PATCH_EMPTY');
    const bytes = s.bytes, document = await docOf(s);
    const applied = await applyPatchV2(bytes, patch, { ir: s.lite, document });
    if (s.bytes !== bytes) fail('E_JWW_EXTERNAL_CHANGE');
    return { status: 'applied', provider: 'manual', attempts: [], ...makePreview(s, applied.bytes, patch, normalized, applied.ir, s.lite) };
  }
  function openSession(name, bytes, { working = false, savedPath = null } = {}) {
    while (studio.size >= 8) studio.delete(studio.keys().next().value);
    const s = { id: randomUUID(), name, working, history: [], edits: 0, savedPath };
    setState(s, bytes, buildScene(bytes, { profile, rules }));
    studio.set(s.id, s); irOf(s).catch(() => {});
    return s;
  }
  async function routeV2(req, url, data) {
    const p = url.pathname.slice('/api/v2/'.length), get = req.method === 'GET';
    if (p === 'bootstrap' && get) {
      const settings = await loadSettings({ file: settingsFile, env });
      return { token, files: await fileList(), rootConfigured: !!root, ai: settingsView(settings), generator: !!generator, profile: !!profile,
        pens: rules?.pens ? { screenRgb: rules.pens.screenRgb ?? {}, printWidth: rules.pens.printWidth_hundredthMm ?? {}, lineTypes: rules.pens.lineTypes ?? {} } : null };
    }
    if (p === 'files' && get) return { files: await fileList() };
    if (p === 'settings' && get) return settingsView(await loadSettings({ file: settingsFile, env }));
    if (p === 'generator' && get) {
      if (!generator) return { available: false };
      const example = await readFile(new URL('../generator/examples/house-a-shell.json', import.meta.url), 'utf8').catch(() => null);
      return { available: true, example };
    }
    if (p === 'scene' && get) return payload(v2(url.searchParams.get('session')));
    if (p === 'entity' && get) {
      const s = v2(url.searchParams.get('session')), id = url.searchParams.get('id');
      const e = s.view.entities.find(x => x.id === id); if (!e) fail('E_ENTITY_MISSING');
      return entityDetails(e, s.view.layers.find(l => l.id === e.layer));
    }
    if (get) fail('E_METHOD');
    if (p === 'settings') {
      const settings = await loadSettings({ file: settingsFile, env }), policy = data.dataPolicy ?? {};
      for (const k of ['sendRealDrawings', 'redactText']) if (policy[k] !== undefined) { if (typeof policy[k] !== 'boolean') fail('E_AI_SETTINGS'); settings.dataPolicy[k] = policy[k]; }
      if (data.provider !== undefined) { if (!['claude', 'claude-fast', 'openai'].includes(data.provider)) fail('E_AI_SETTINGS'); settings.providers.default = data.provider; }
      await saveSettings(settings, { file: settingsFile });
      return settingsView(await loadSettings({ file: settingsFile, env }));
    }
    if (p === 'open') {
      const file = files.get(data.fileId) ?? (await listFiles(), files.get(data.fileId)); if (!file) fail('E_FILE_SELECTION');
      const info = await stat(file.path); if (info.size > 32 * 1024 * 1024) fail('E_JWW_SIZE');
      return payload(openSession(path.basename(file.path), await readFile(file.path), { working: !!file.working, savedPath: file.working ? file.path : null }));
    }
    if (p === 'close') { studio.delete(data.sessionId); return { closed: true }; }
    if (p === 'generate') {
      if (!generator) fail('E_GENERATOR_MISSING');
      let result;
      try { result = generator.drawPlan(data.spec); }
      catch (error) { if (error.code === 'E_SPEC') return { status: 'invalid', details: (error.details ?? []).slice(0, 30).map(String) }; throw error; }
      const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15);
      const target = path.join(workRoot, `plan-${stamp}-${randomUUID().slice(0, 6)}.jww`);
      await writeFile(target, result.bytes, { flag: 'wx' });
      await listFiles();
      const s = openSession(path.basename(target), Buffer.from(result.bytes), { working: true, savedPath: target });
      return { status: 'generated', ...payload(s), warnings: (result.warnings ?? []).slice(0, 30).map(String) };
    }
    const s = v2(data.sessionId);
    if (p === 'reject') { s.pending = null; return { rejected: true }; }
    if (p === 'undo') {
      const prev = s.history.pop(); if (!prev) fail('E_UNDO_EMPTY');
      Object.assign(s, prev); s.pending = null;
      return payload(s);
    }
    if (p === 'accept') {
      const pending = s.pending;
      if (!pending || pending.id !== data.previewId || pending.baseHash !== s.hash) fail('E_PREVIEW_STALE');
      // Never overwrite: every accepted change is a new file next to the working copies.
      const stem = path.basename(s.name, path.extname(s.name)).replace(/-edit-\d+-[0-9a-f]{6}$/u, '').slice(0, 80);
      const target = path.join(workRoot, `${stem}-edit-${String(++s.edits).padStart(2, '0')}-${randomUUID().slice(0, 6)}.jww`);
      const file = await open(target, 'wx');
      try { await file.writeFile(pending.bytes); await file.sync(); } catch (error) { await file.close(); await unlink(target).catch(() => {}); throw error; }
      await file.close();
      const { bytes, hash: h, scene, lite, view, ids, irP, docP, name, savedPath } = s;
      s.history.push({ bytes, hash: h, scene, lite, view, ids, irP, docP, name, savedPath });
      if (s.history.length > 20) s.history.shift();
      setState(s, pending.bytes, pending.built);
      if (pending.ir) s.irP = Promise.resolve(pending.ir);
      s.name = path.basename(target); s.savedPath = target;
      await listFiles();
      return { ...payload(s), savedPath: target, outputHash: s.hash };
    }
    if (p === 'patch') { if (data.baseHash !== s.hash) fail('E_JWW_EXTERNAL_CHANGE'); return applyManual(s, data.patch); }
    if (p === 'fix-layers') {
      const pending = s.pending;
      if (!pending || pending.id !== data.previewId || pending.baseHash !== s.hash) fail('E_PREVIEW_STALE');
      if (!pending.corrections.length) fail('E_LAYER_NO_CORRECTION');
      return applyManual(s, { ...pending.patch, ops: applyLayerCorrections(pending.patch.ops, pending.corrections) });
    }
    if (p === 'edit') {
      if (data.baseHash !== s.hash) fail('E_JWW_EXTERNAL_CHANGE');
      if (typeof data.instruction !== 'string' || !data.instruction.trim() || data.instruction.length > 2000) fail('E_AI_INSTRUCTION');
      const selection = data.selection ?? [];
      if (!Array.isArray(selection) || selection.length > 500 || selection.some(id => typeof id !== 'string' || !s.ids.has(id))) fail('E_SELECTION');
      const settings = await loadSettings({ file: settingsFile, env }), keys = keyStatus();
      let provider = data.provider ?? 'auto';
      if (!['auto', 'mock', 'claude', 'claude-fast', 'openai'].includes(provider)) fail('E_AI_PROVIDER');
      if (provider === 'auto') provider = keys[keyFamily(settings.providers.default)] ? settings.providers.default : 'mock';
      if (provider !== 'mock' && !keys[keyFamily(provider)]) {
        return { status: 'failed', provider, attempts: [], error: { code: 'E_AI_KEY_REQUIRED', detail: keyFamily(provider) === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY' } };
      }
      s.pending = null;
      const bytes = s.bytes, [ir, document] = await Promise.all([irOf(s), docOf(s)]);
      if (s.bytes !== bytes || ir.sourceHash !== s.hash) fail('E_JWW_EXTERNAL_CHANGE');
      const mock = provider === 'mock';
      // The selection is user input: real providers get the ids as a hint and still verify with their read-only tools.
      const instruction = selection.length && !mock ? `${data.instruction}\n\n(選択中の要素 / selected ids: ${selection.slice(0, 50).join(', ')})` : data.instruction;
      const runSettings = mock ? { ...settings, dataPolicy: { ...settings.dataPolicy, sendRealDrawings: true, redactText: false }, experience: { ...settings.experience, enabled: false } } : settings;
      const result = await runEdit({ bytes, instruction, settings: runSettings,
        provider: mock ? createMockProvider({ script: mockEditScript({ selection, layers: ir.layers.map(l => l.id) }) }) : provider,
        deps: { env, fetch: aiFetch, loadIR: async () => ir, applyPatchV2: (b, patch, o) => applyPatchV2(b, patch, { ...o, document }), ...(mock ? { experience: false } : {}) } });
      if (s.bytes !== bytes) fail('E_JWW_EXTERNAL_CHANGE');
      const common = { status: result.status, provider: mock ? 'mock' : result.provider, model: result.model, demo: mock, runId: result.runId, latencyMs: result.latencyMs,
        attempts: result.attempts.map(a => ({ attempt: a.attempt, status: a.status, error: a.error, toolCalls: a.toolCalls, latencyMs: a.latencyMs })),
        usage: result.usage, costEstimate: result.costEstimate, warnings: result.warnings ?? [] };
      if (result.status === 'clarification') return { ...common, question: result.question };
      if (result.status !== 'applied') return { ...common, error: result.error };
      return { ...common, ...makePreview(s, result.outputBytes, result.patch, result.normalizedPatch, result.outputIR, ir) };
    }
    fail('E_NOT_FOUND');
  }
  return createServer(async (req, res) => {
    const address = `127.0.0.1:${req.socket.localPort}`, origin = `http://${address}`;
    const url = new URL(req.url, origin);
    if (STUDIO_ASSETS.has(url.pathname)) return serveAsset(req, res, address, url.pathname);
    if (!url.pathname.startsWith('/api/')) return staticHandler(req, res);
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); };
    if (req.headers.host !== address || (req.headers.origin && req.headers.origin !== origin)) return send(403, { error: 'E_ORIGIN' });
    if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'E_METHOD' });
    if (req.method === 'POST' && (req.headers.origin !== origin || req.headers['x-fresco-token'] !== token)) return send(403, { error: 'E_TOKEN' });
    if (req.method === 'GET' && url.pathname === '/api/download') {
      try { const value = session(url.searchParams.get('session')); const bytes = await readFile(value.path);
        res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Disposition', `attachment; filename="drawing.jww"; filename*=UTF-8''${encodeURIComponent(path.basename(value.path))}`); res.writeHead(200); res.end(bytes);
      } catch { send(404, { error: 'E_FILE_READ' }); } return;
    }
    if (req.method === 'GET' && !GET_ROUTES.has(url.pathname)) return send(405, { error: 'E_METHOD' });
    const mutates = req.method === 'POST' && url.pathname !== '/api/ai';
    if (mutates && mutationBusy) return send(409, { error: 'E_BUSY' });
    if (mutates) mutationBusy = true;
    try { const data = req.method === 'POST' ? await bodyOf(req) : {}; send(200, await route(req, url, data)); }
    catch (error) {
      const code = typeof error.code === 'string' && /^E_[A-Z_0-9]+$/u.test(error.code) ? error.code : 'E_STUDIO_OPERATION';
      send(code === 'E_NOT_FOUND' ? 404 : 400, { error: code, ...(code.startsWith('E_PATCH') && typeof error.detail === 'string' ? { detail: error.detail.slice(0, 200) } : {}) });
    }
    finally { if (mutates) mutationBusy = false; }
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.argv[2] ?? 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const server = await studioServer({ drawingRoot: process.argv[3] ?? process.env.FRESCO_DRAWING_ROOT });
  server.on('error', error => { console.error(error.code ?? 'E_SERVER'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`JWW Studio: http://127.0.0.1:${port}/ui/studio.html`));
}
