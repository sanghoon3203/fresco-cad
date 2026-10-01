// JWW edit engine: validated Patch v2 -> writer (pure-JS codec | JwwHelper DLL rewrite) -> DLL re-read -> compare with an independently planned state.
// The codec writer keeps untouched bytes; the DLL writer re-serializes everything (not byte-exact). See docs/jw-assistant/jww-edit.md.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, readJww } from './jww.mjs';
import { toIR } from './jww-pipeline.mjs';
import { validatePatchV2 } from '../core/patch-v2.mjs';
import { decodeJww, encodeJww, SPAN } from './codec/jww-codec.mjs';
import { applyOps } from './codec/jww-ops.mjs';

const execute = promisify(execFile);
const fail = (code, detail) => { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, detail }); };
const lid = p => `${p.m_nGLayer.toString(16).toUpperCase()}:${p.m_nLayer.toString(16).toUpperCase()}`;
const rad = d => d * Math.PI / 180;
const snap = v => Math.abs(v) < 1e-12 ? 0 : v;
const LIMIT = 1e9, DEFAULT_FONT = 'ＭＳ ゴシック';
// Header fields the DLL is known to alter on rewrite: version (600 -> 700) and the three saved 3D eye-height presets.
const HEADER_ALLOWED = new Set(['m_jwwDataVersion', 'm_dEye_H_Ichi_1', 'm_dEye_H_Ichi_2', 'm_dEye_H_Ichi_3']);

// ---- CP932 representability (the native writer re-encodes strings as ANSI) -------------------------------------------
let encodable;
function buildEncodable() {
  const set = new Set(['\t', '\n', '\r']), decoder = new TextDecoder('shift_jis', { fatal: true });
  for (let b = 0x20; b <= 0x7e; b++) set.add(String.fromCharCode(b));
  for (let b = 0xa1; b <= 0xdf; b++) set.add(decoder.decode(Uint8Array.of(b)));
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (lead > 0x9f && lead < 0xe0) continue;
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      try { const s = decoder.decode(Uint8Array.of(lead, trail)); if ([...s].length === 1) set.add(s); } catch {}
    }
  }
  return set;
}
export const isCp932 = ch => (encodable ??= buildEncodable()).has(ch);
export const findUnrepresentable = (string, limit = 5) => [...new Set([...string].filter(ch => !isCp932(ch)))].slice(0, limit).map(ch => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
const isHalf = ch => { const c = ch.codePointAt(0); return c < 0x80 || (c >= 0xff61 && c <= 0xff9f); };
// Jw_cad text extent (fits 1968 of 2003 real corpus texts; 24 have zero length): half-width chars are sizeX/2 and get half the
// char spacing. `uniformSpacing` is the simpler rule (full spacing for every gap) that the pure-JS codec uses.
export function textWidth(string, sizeX, kankaku, { uniformSpacing = false } = {}) {
  const chars = [...string]; let width = 0, gaps = 0;
  chars.forEach((ch, i) => { const half = isHalf(ch); width += half ? sizeX / 2 : sizeX; if (i < chars.length - 1) gaps += half && !uniformSpacing ? 0.5 : 1; });
  return width + kankaku * gaps;
}
function* stringsOf(document, header) {
  const walk = function* (entity, where) {
    for (const [name, value] of Object.entries(entity.props)) if (typeof value === 'string') yield [`${where}.${name}`, value];
    for (const child of entity.components ?? []) yield* walk(child, `${where}/${child.id}`);
  };
  for (const entity of document.entities) yield* walk(entity, entity.id);
  for (const block of document.blocks ?? []) { if (typeof block.name === 'string') yield [`${block.id}.name`, block.name]; for (const entity of block.entities) yield* walk(entity, entity.id); }
  for (const layer of document.layers) for (const k of ['groupName', 'name']) if (typeof layer[k] === 'string') yield [`layer ${layer.id}.${k}`, layer[k]];
  if (header) for (const [name, value] of Object.entries(header)) {
    if (typeof value === 'string') yield [`header.${name}`, value];
    else if (Array.isArray(value)) for (const item of value.flat(2)) if (typeof item === 'string') yield [`header.${name}[]`, item];
  }
}
export function staticRewriteProblems(bytes, document, header) {
  const reasons = [], version = bytes.readInt32LE(8);
  if (version < 351) reasons.push(`file version ${version} < 351`);
  const dims = [...document.entities, ...(document.blocks ?? []).flatMap(b => b.entities)].filter(e => e.type === 'JwwSunpou').length;
  if (dims) reasons.push(`${dims} dimension entities (JwwSunpou): auxiliary geometry is not exposed by the native wrapper, so a rewrite cannot be verified`);
  const bad = new Map();
  for (const [where, value] of stringsOf(document, header)) { const chars = findUnrepresentable(value); if (chars.length && !bad.has(where.replace(/e\d+/gu, 'e*'))) bad.set(where.replace(/e\d+/gu, 'e*'), `${where} has ${chars.join(',')}`); }
  for (const text of [...bad.values()].slice(0, 5)) reasons.push(`non-CP932 character: ${text}`);
  if (bad.size > 5) reasons.push(`...and ${bad.size - 5} more non-CP932 locations`);
  return reasons;
}

// ---- native process --------------------------------------------------------------------------------------------------
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const script = fileURLToPath(new URL('./Write-Jww.ps1', import.meta.url));
async function runWriter(bytes, { mode = 'Write', ops = [] } = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'fresco-jww-w-'));
  const input = path.join(folder, 'source.jww'), plan = path.join(folder, 'ops.json'), output = path.join(folder, mode === 'Write' ? 'out.jww' : 'header.json');
  try {
    await writeFile(input, bytes, { flag: 'wx' });
    await writeFile(plan, JSON.stringify({ ops: ops.map(wireOp) }), { flag: 'wx' });
    let stdout;
    try {
      ({ stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-InputPath', input, '-OpsPath', plan, '-OutputPath', output, '-Mode', mode],
        { windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }));
    } catch (error) {
      const detail = /E_JWW_NATIVE_WRITE:\s*(.*)/u.exec(String(error.stderr ?? ''))?.[1]?.trim() ?? (error.killed ? 'timeout' : String(error.message).slice(0, 200));
      fail('E_JWW_NATIVE_WRITE', detail);
    }
    if (mode === 'Header') return { header: JSON.parse(await readFile(output, 'utf8')) };
    return { bytes: await readFile(output), summary: JSON.parse(stdout) };
  } finally { for (const file of [input, plan, output]) await unlink(file).catch(() => {}); await rmdir(folder).catch(() => {}); }
}
// Numbers travel as strings so the PowerShell side parses the exact double.
const wireProps = props => Object.fromEntries(Object.entries(props).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v]));
const wireOp = op => op.props ? { ...op, props: wireProps(op.props) } : op;
export const readHeader = async bytes => (await runWriter(bytes, { mode: 'Header' })).header;

// ---- planning: normalized model-mm ops -> native ops + expected document ---------------------------------------------
const finite = (v, what) => { if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > LIMIT) fail('E_JWW_VALUE', what); return v; };
const NO_GEOMETRY = ['JwwSunpou'];

function textDefaults(header) {
  if (!header) return null;
  return { shu: header.m_nMojiShu, sizeX: header.m_dMojiSizeX, sizeY: header.m_dMojiSizeY, kankaku: header.m_dMojiKankaku, color: header.m_nMojiColor,
    X: header.m_adMojiX, Y: header.m_adMojiY, D: header.m_adMojiD, C: header.m_anMojiCol };
}
function arcFields(startDeg, sweepDeg) {
  const norm = d => ((d % 360) + 360) % 360, full = Math.abs(sweepDeg) >= 360;
  if (full) return { m_bZenEnFlg: 1, m_radKaishiKaku: rad(norm(startDeg)), m_radEnkoKaku: rad(360) };
  return sweepDeg > 0 ? { m_bZenEnFlg: 0, m_radKaishiKaku: rad(norm(startDeg)), m_radEnkoKaku: rad(sweepDeg) }
    : { m_bZenEnFlg: 0, m_radKaishiKaku: rad(norm(startDeg + sweepDeg)), m_radEnkoKaku: rad(-sweepDeg) };
}
function setTextEnd(p, from = [p.m_start_x, p.m_start_y]) {
  const width = textWidth(p.m_string, p.m_dSizeX, p.m_dKankaku), a = rad(p.m_degKakudo);
  p.m_end_x = from[0] + width * snap(Math.cos(a)); p.m_end_y = from[1] + width * snap(Math.sin(a));
}
function checkText(text, where) {
  if (/\n/u.test(text)) fail('E_JWW_TEXT_MULTILINE', `${where}: one JwwMoji holds one line`);
  const bad = findUnrepresentable(text);
  if (bad.length) fail('E_JWW_TEXT_CHAR', `${where}: ${bad.join(',')} is not representable in CP932 (the native writer would corrupt it)`);
}

export function planNativeOps(document, ops, { header } = {}) {
  const layerScale = new Map(document.layers.map(l => [l.id, l.scale]));
  const scaleOf = id => { const s = layerScale.get(id); if (!Number.isFinite(s) || !(s > 0)) fail('E_JWW_SCALE', id); return s; };
  const items = document.entities.map((e, index) => ({ id: e.id, index, type: e.type, before: e.props, props: { ...e.props }, components: e.components, added: false, deleted: false }));
  const byId = new Map(items.map(i => [i.id, i])), temps = new Map(), adds = [], defaults = textDefaults(header);
  const fonts = {}; for (const e of document.entities) if (e.type === 'JwwMoji' && e.props.m_strFontName) fonts[e.props.m_strFontName] = (fonts[e.props.m_strFontName] ?? 0) + 1;
  const font = Object.entries(fonts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? DEFAULT_FONT;
  const target = id => { const item = temps.get(id) ?? byId.get(id); if (!item || item.deleted) fail('E_JWW_TARGET', id); return item; };
  const unsupported = (item, what) => fail('E_JWW_UNSUPPORTED_ENTITY', `${item.id ?? item.tempId}:${item.type} cannot ${what}${item.type === 'JwwSunpou' ? ' (dimension auxiliary geometry is not exposed by the native wrapper)' : ''}`);

  const penOf = (pen = {}) => {
    if (pen.style === 100) fail('E_JWW_PEN_STYLE', 'style 100 is the symbol-point style and needs symbol fields');
    if (pen.width > 32767) fail('E_JWW_VALUE', 'pen.width exceeds Int16');
    return { m_nPenColor: pen.color ?? 1, m_nPenStyle: pen.style ?? 1, m_nPenWidth: pen.width ?? 0 };
  };
  const base = (layer, pen) => { const [g, l] = layer.split(':').map(s => parseInt(s, 16)); return { m_lGroup: 0, m_sFlg: 0, m_nGLayer: g, m_nLayer: l, ...penOf(pen) }; };

  function build(entity) {
    const scale = scaleOf(entity.layer), xy = (point, what) => point.map(v => finite(v / scale, what));
    if (entity.kind === 'line') {
      const [sx, sy] = xy(entity.start, 'line.start'), [ex, ey] = xy(entity.end, 'line.end');
      return { type: 'JwwSen', props: { ...base(entity.layer, entity.pen), m_start_x: sx, m_start_y: sy, m_end_x: ex, m_end_y: ey } };
    }
    if (entity.kind === 'point') { const [x, y] = xy(entity.at, 'point.at'); return { type: 'JwwTen', props: { ...base(entity.layer, entity.pen), m_bKariten: 0, m_start_x: x, m_start_y: y } }; }
    if (entity.kind === 'arc') {
      const [x, y] = xy(entity.center, 'arc.center');
      return { type: 'JwwEnko', props: { ...base(entity.layer, entity.pen), m_start_x: x, m_start_y: y, m_dHankei: finite(entity.radius / scale, 'arc.radius'),
        ...arcFields(entity.startAngle, entity.sweepAngle), m_dHenpeiRitsu: entity.flatness ?? 1, m_radKatamukiKaku: rad(entity.tilt ?? 0) } };
    }
    checkText(entity.text, 'text');
    if (!defaults) fail('E_JWW_HEADER', 'text defaults need the file header');
    const [x, y] = xy(entity.at, 'text.at'), style = entity.style ?? null;
    if (style !== null && (style < 1 || style > defaults.X.length)) fail('E_JWW_VALUE', `text.style ${style}`);
    const at = style === null ? { shu: defaults.shu, sizeX: defaults.sizeX, sizeY: defaults.sizeY, kankaku: defaults.kankaku, color: defaults.color }
      : { shu: style, sizeX: defaults.X[style - 1], sizeY: defaults.Y[style - 1], kankaku: defaults.D[style - 1], color: defaults.C[style - 1] };
    const sized = entity.height !== undefined || entity.width !== undefined;
    const sizeY = entity.height ?? at.sizeY, sizeX = entity.width ?? at.sizeX; // null = drawing default (patch-v2.md), per field
    const props = { ...base(entity.layer, { color: entity.color ?? at.color, style: 1 }), m_string: entity.text, m_strFontName: font, m_degKakudo: entity.angle ?? 0,
      m_dKankaku: entity.spacing ?? at.kankaku, m_dSizeY: sizeY, m_dSizeX: sizeX, m_nMojiShu: sized ? 0 : at.shu, m_start_x: x, m_start_y: y };
    setTextEnd(props);
    return { type: 'JwwMoji', props, endApprox: true };
  }

  function move(item, dx, dy) {
    const p = item.props, scale = scaleOf(lid(p)), fx = finite(dx / scale, 'dx'), fy = finite(dy / scale, 'dy');
    const pairs = { JwwSen: ['start', 'end'], JwwMoji: ['start', 'end'], JwwTen: ['start'], JwwEnko: ['start'] }[item.type];
    if (pairs) for (const k of pairs) { p[`m_${k}_x`] = finite(p[`m_${k}_x`] + fx, 'x'); p[`m_${k}_y`] = finite(p[`m_${k}_y`] + fy, 'y'); }
    else if (item.type === 'JwwSolid') {
      for (const k of ['m_start', 'm_end', 'm_DPoint2', 'm_DPoint3']) { p[`${k}_x`] += fx; p[`${k}_y`] += fy; }
    } else if (item.type === 'JwwBlock') { p.m_DPKijunTen_x += fx; p.m_DPKijunTen_y += fy; }
    else unsupported(item, 'translate');
    if (![...Object.values(p)].every(v => v === null || typeof v !== 'number' || Number.isFinite(v))) fail('E_JWW_VALUE', `${item.id ?? item.tempId} translate`);
  }

  function modify(item, set) { // eslint-disable-line complexity
    const p = item.props, scale = scaleOf(lid(p)), allowed = { JwwSen: ['start', 'end'], JwwMoji: ['at', 'text', 'height', 'width', 'angle'], JwwEnko: ['center', 'radius', 'startAngle', 'sweepAngle'], JwwTen: ['at'] }[item.type];
    if (!allowed) unsupported(item, 'modify');
    for (const k of Object.keys(set)) if (!allowed.includes(k)) fail('E_JWW_MODIFY_FIELD', `${item.id ?? item.tempId}.${k} is not valid for ${item.type}`);
    const put = (name, point) => { p[`m_${name}_x`] = finite(point[0] / scale, name); p[`m_${name}_y`] = finite(point[1] / scale, name); };
    if (item.type === 'JwwSen') {
      if (set.start) put('start', set.start); if (set.end) put('end', set.end);
      if (p.m_start_x === p.m_end_x && p.m_start_y === p.m_end_y) fail('E_JWW_VALUE', 'modify makes a zero-length line');
    } else if (item.type === 'JwwTen') put('start', set.at);
    else if (item.type === 'JwwEnko') {
      if (set.center) put('start', set.center);
      if (set.radius !== undefined) p.m_dHankei = finite(set.radius / scale, 'radius');
      if (set.sweepAngle !== undefined) Object.assign(p, arcFields(set.startAngle ?? p.m_radKaishiKaku * 180 / Math.PI, set.sweepAngle));
      else if (set.startAngle !== undefined) p.m_radKaishiKaku = rad(((set.startAngle % 360) + 360) % 360);
    } else {
      const shape = set.text !== undefined || set.width !== undefined || set.angle !== undefined;
      if (set.text !== undefined) { checkText(set.text, 'set.text'); p.m_string = set.text; }
      if (set.height !== undefined) p.m_dSizeY = finite(set.height, 'height');
      if (set.width !== undefined) p.m_dSizeX = finite(set.width, 'width');
      if (set.angle !== undefined) p.m_degKakudo = finite(set.angle, 'angle');
      if (set.at) { const dx = set.at[0] / scale - p.m_start_x, dy = set.at[1] / scale - p.m_start_y; put('start', set.at); p.m_end_x += dx; p.m_end_y += dy; }
      // Explicit sizes make the text 任意サイズ (type 0); the +10000/+20000 style flags stay (same rule as the codec).
      if (set.height !== undefined || set.width !== undefined) p.m_nMojiShu -= p.m_nMojiShu % 10000;
      if (shape) { setTextEnd(p); item.endApprox = true; }
    }
  }

  function setLayer(item, layer) {
    if (NO_GEOMETRY.includes(item.type)) unsupported(item, 'change layer');
    const p = item.props, from = scaleOf(lid(p)), to = scaleOf(layer), [g, l] = layer.split(':').map(s => parseInt(s, 16));
    if (from !== to) {
      if (!['JwwSen', 'JwwMoji', 'JwwTen', 'JwwEnko', 'JwwSolid'].includes(item.type)) fail('E_JWW_SETLAYER_SCALE', `${item.id ?? item.tempId}:${item.type} cannot move between groups of different scale (${from} -> ${to})`);
      const f = from / to;
      if (item.type === 'JwwMoji') { const ex = p.m_end_x - p.m_start_x, ey = p.m_end_y - p.m_start_y; p.m_start_x *= f; p.m_start_y *= f; p.m_end_x = p.m_start_x + ex; p.m_end_y = p.m_start_y + ey; }
      else {
        for (const k of ['m_start_x', 'm_start_y', 'm_end_x', 'm_end_y', 'm_DPoint2_x', 'm_DPoint2_y', 'm_DPoint3_x', 'm_DPoint3_y']) if (k in p) p[k] *= f;
        if (item.type === 'JwwEnko') p.m_dHankei *= f;
      }
    }
    p.m_nGLayer = g; p.m_nLayer = l;
  }

  function setPen(item, pen) {
    const p = item.props;
    if (!['JwwSen', 'JwwEnko', 'JwwTen', 'JwwMoji'].includes(item.type)) unsupported(item, 'setPen');
    if (item.type === 'JwwMoji' && (pen.style !== undefined || pen.width !== undefined)) fail('E_JWW_PEN_UNSUPPORTED', `${item.id ?? item.tempId}: text takes color only`);
    const next = penOf(pen);
    if (pen.color !== undefined) p.m_nPenColor = next.m_nPenColor;
    if (pen.style !== undefined) p.m_nPenStyle = next.m_nPenStyle;
    if (pen.width !== undefined) p.m_nPenWidth = next.m_nPenWidth;
  }

  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        const { type, props, endApprox } = build(op.entity), item = { id: null, tempId: op.tempId ?? null, index: null, type, props, endApprox: !!endApprox, added: true, deleted: false };
        adds.push(item); if (op.tempId) temps.set(op.tempId, item); break;
      }
      case 'delete': for (const id of op.ids) { const item = target(id); item.deleted = true; if (item.added) adds.splice(adds.indexOf(item), 1); } break;
      case 'translate': for (const id of op.ids) move(target(id), op.dx, op.dy); break;
      case 'modify': modify(target(op.id), op.set); break;
      case 'setLayer': for (const id of op.ids) setLayer(target(id), op.layer); break;
      case 'setPen': for (const id of op.ids) setPen(target(id), op.pen); break;
      default: fail('E_JWW_OP', op.op);
    }
  }
  const native = [], kept = items.filter(i => !i.deleted);
  for (const item of items) {
    if (item.deleted) { native.push({ op: 'delete', index: item.index }); continue; }
    const diff = Object.fromEntries(Object.entries(item.props).filter(([k, v]) => item.before[k] !== v));
    if (Object.keys(diff).length) native.push({ op: 'set', index: item.index, type: item.type, props: diff });
  }
  for (const item of adds) native.push({ op: 'add', type: item.type, props: item.props });
  const expected = [...kept, ...adds].map(item => ({ from: item.id, type: item.type, props: item.props, touched: item.added || Object.keys(item.props).some(k => item.before[k] !== item.props[k]), components: item.components, endApprox: !!item.endApprox }));
  const created = Object.fromEntries(adds.filter(i => i.tempId).map(i => [i.tempId, `e${kept.length + adds.indexOf(i)}`]));
  return { nativeOps: native, expected, created };
}

// ---- verification ----------------------------------------------------------------------------------------------------
const TAU = 2 * Math.PI;
const close = (a, b, tol) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)));
// Text end points approximate Jw_cad's own rule: accept anything on the text baseline whose length lies between the
// half-spacing rule (fits the corpus) and the uniform-spacing rule (codec). A wrong direction or scaled extent is rejected.
function endOk(g) {
  const dx = g.m_end_x - g.m_start_x, dy = g.m_end_y - g.m_start_y, a = rad(g.m_degKakudo), len = Math.hypot(dx, dy);
  const along = dx * Math.cos(a) + dy * Math.sin(a), across = -dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(across) <= 1e-9 * Math.max(1, len) && along >= textWidth(g.m_string, g.m_dSizeX, g.m_dKankaku) - 1e-9
    && along <= textWidth(g.m_string, g.m_dSizeX, g.m_dKankaku, { uniformSpacing: true }) + 1e-9;
}
const sameAngle = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(((((a - b) % TAU) + TAU + 1e-9) % TAU) - 1e-9) <= 1e-9;
/**
 * Compare a re-read document (DLL reader) with the expected state. `codec` mode: the header must be identical (no DLL
 * quirks allowed), touched geometry is compared to 1e-12 and approximate text ends / equivalent arc start angles are accepted.
 */
export function verifyRewrite(before, expected, after, { headerBefore, headerAfter, codec = false } = {}) {
  const problems = [], add = text => { if (problems.length < 12) problems.push(text); };
  for (const key of ['layers', 'blocks', 'imageMetadata']) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) add(`${key} changed`);
  if (before.blockDefinitions !== after.blockDefinitions || before.images !== after.images) add('block/image count changed');
  if (codec ? after.version !== before.version : !(after.version >= before.version)) add(`version ${before.version} -> ${after.version}`);
  if (after.entities.length !== expected.length) add(`entity count ${after.entities.length}, expected ${expected.length}`);
  const newIds = new Map();
  expected.forEach((item, i) => { if (item.from) newIds.set(item.from, { id: `e${i}`, touched: item.touched }); });
  expected.forEach((item, i) => {
    const got = after.entities[i], where = `e${i}${item.from ? `(was ${item.from})` : '(added)'}`;
    if (!got) return;
    if (got.type !== item.type) return add(`${where} type ${got.type}, expected ${item.type}`);
    const names = new Set([...Object.keys(item.props), ...Object.keys(got.props)]), loose = codec && item.touched;
    for (const name of names) {
      const a = got.props[name] ?? null, b = item.props[name] ?? null;
      if ((name in got.props) !== (name in item.props)) { add(`${where}.${name} present=${name in got.props}, expected ${name in item.props}`); continue; }
      if (a === b) continue;
      if (loose && item.endApprox && (name === 'm_end_x' || name === 'm_end_y')) continue;
      if (loose && close(a, b, 1e-12)) continue;
      if (loose && item.type === 'JwwEnko' && name === 'm_radKaishiKaku' && sameAngle(a, b)) continue;
      add(`${where}.${name} = ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
    }
    if (loose && item.endApprox && !endOk(got.props)) add(`${where} text end (${got.props.m_end_x}, ${got.props.m_end_y}) is not on the baseline with a Jw_cad-like length`);
    if (item.from && !item.touched && JSON.stringify(got.components) !== JSON.stringify(item.components)) add(`${where} components changed`);
  });
  const fixId = d => { if (!d.entityId) return d; const [root, ...rest] = d.entityId.split('/'), n = newIds.get(root); return n && !n.touched ? { ...d, entityId: [n.id, ...rest].join('/') } : null; };
  const untouched = new Set([...newIds.values()].filter(n => !n.touched).map(n => n.id));
  const wanted = (before.diagnostics ?? []).map(fixId).filter(Boolean).map(d => JSON.stringify(d)).sort();
  const got = (after.diagnostics ?? []).filter(d => !d.entityId || untouched.has(d.entityId.split('/')[0])).map(d => JSON.stringify(d)).sort();
  if (JSON.stringify(wanted) !== JSON.stringify(got)) add('diagnostics changed');
  if (headerBefore && headerAfter) {
    for (const name of new Set([...Object.keys(headerBefore), ...Object.keys(headerAfter)])) {
      if (name === 'acp' || (!codec && HEADER_ALLOWED.has(name))) continue;
      if (JSON.stringify(headerBefore[name]) !== JSON.stringify(headerAfter[name])) add(`header ${name} changed`);
    }
  }
  return problems;
}
const diffBytes = (a, b) => { let n = Math.abs(a.length - b.length); for (let i = 0, m = Math.min(a.length, b.length); i < m; i++) if (a[i] !== b[i]) n++; return n; };

// Are the header, every untouched entity record (ignoring MFC class tags) and the blocks/images tail unchanged?
// null = not checkable (partial decode). Entities are matched through the plan's `from` ids.
export function byteExactOutsideEdits(bytes, output, expected) {
  const a = decodeJww(bytes), b = decodeJww(output);
  if (a.partial || b.partial) return null;
  if (Buffer.compare(bytes.subarray(...a.spans.header), output.subarray(...b.spans.header)) !== 0) return false;
  if (Buffer.compare(bytes.subarray(a.spans.blocks[0]), output.subarray(b.spans.blocks[0])) !== 0) return false;
  const body = (buf, e) => { const [from, to, kind] = e[SPAN]; return buf.subarray(from + (kind === 'new' ? 6 + e.cls.length : 2), to); };
  return expected.every((item, i) => !item.from || item.touched
    || Buffer.compare(body(bytes, a.entities[Number(item.from.slice(1))]), body(output, b.entities[i])) === 0);
}

// ---- public API ------------------------------------------------------------------------------------------------------
const WRITERS = ['codec', 'dll'];
export async function probeRewriteSafety(bytes, { document, returnBytes = false, writer = 'codec' } = {}) {
  if (!WRITERS.includes(writer)) fail('E_JWW_WRITER', writer);
  const before = document ?? await readJww(bytes), reasons = [], notes = [];
  let byteExact = false, differingBytes = null, output = null, headerBefore = null;
  if (writer === 'codec') {
    try {
      const doc = decodeJww(bytes);
      if (doc.partial) reasons.push(`codec partial decode: ${doc.partial.message}`);
      else { output = encodeJww(doc); headerBefore = (await runWriter(bytes, { mode: 'Header' })).header; }
    } catch (error) { reasons.push(`codec failed: ${error.message}`); }
  } else {
    reasons.push(...staticRewriteProblems(bytes, before));
    try { const result = await runWriter(bytes, { ops: [] }); output = result.bytes; headerBefore = result.summary.header; } catch (error) { reasons.push(`writer failed: ${error.message}`); }
    if (headerBefore) reasons.push(...staticRewriteProblems(bytes, { entities: [], layers: [], blocks: [] }, headerBefore).filter(r => r.includes('header.')));
  }
  if (output) {
    byteExact = Buffer.compare(bytes, output) === 0; differingBytes = diffBytes(bytes, output);
    if (!byteExact || writer === 'dll') {
      try {
        const after = await readJww(output), headerAfter = (await runWriter(output, { mode: 'Header' })).header;
        reasons.push(...verifyRewrite(before, before.entities.map(e => ({ from: e.id, type: e.type, props: e.props, touched: false, components: e.components })), after, { headerBefore, headerAfter, codec: writer === 'codec' }));
        if (writer === 'dll') for (const name of HEADER_ALLOWED) if (JSON.stringify(headerBefore[name]) !== JSON.stringify(headerAfter[name])) notes.push(`header ${name} ${JSON.stringify(headerBefore[name])} -> ${JSON.stringify(headerAfter[name])}`);
      } catch (error) { reasons.push(`re-read failed: ${error.message}`); }
    }
  }
  return { safe: reasons.length === 0, writer, byteExact, differingBytes, reasons, notes, ...(returnBytes && output ? { bytes: output } : {}) };
}

/**
 * Apply a Patch v2. writer 'codec' (default): pure-JS decode -> applyOps -> encode; 'dll': JwwHelper full rewrite.
 * Either way the output is re-read with the DLL reader and compared with the state this module plans independently.
 */
export async function applyPatchV2(bytes, patch, { ir, document, writer = 'codec' } = {}) {
  if (!Buffer.isBuffer(bytes)) fail('E_JWW_FORMAT');
  if (!WRITERS.includes(writer)) fail('E_JWW_WRITER', writer);
  const sourceHash = hash(bytes), before = document ?? await readJww(bytes), dll = writer === 'dll';
  if (ir && ir.sourceHash !== sourceHash) fail('E_PATCH_STALE', 'ir does not describe these bytes');
  const normalized = validatePatchV2(patch, ir ?? toIR(bytes, before));
  if (!normalized.ops.length) fail('E_PATCH_NO_OPS', 'clarification-only patch');
  if (dll) { const early = staticRewriteProblems(bytes, before); if (early.length) fail('E_JWW_REWRITE_UNSAFE', early.join('; ')); }
  const headerBefore = !dll || normalized.ops.some(op => op.op === 'add' && op.entity.kind === 'text') ? await readHeader(bytes) : null;
  const plan = planNativeOps(before, normalized.ops, { header: headerBefore });
  let output, summary = null;
  if (dll) {
    ({ bytes: output, summary } = await runWriter(bytes, { ops: plan.nativeOps }));
    const bad = staticRewriteProblems(bytes, { entities: [], layers: [], blocks: [] }, summary.header).filter(r => r.includes('header.'));
    if (bad.length) fail('E_JWW_REWRITE_UNSAFE', bad.join('; '));
  } else {
    const source = decodeJww(bytes);
    if (source.partial) fail('E_JWW_CODEC_PARTIAL', source.partial.message);
    output = encodeJww(applyOps(source, normalized.ops).doc);
  }
  const after = await readJww(output), headerAfter = await readHeader(output);
  const problems = verifyRewrite(before, plan.expected, after, { headerBefore: dll ? summary.header : headerBefore, headerAfter, codec: !dll });
  if (!dll && Buffer.compare(encodeJww(decodeJww(output)), output) !== 0) problems.push('codec re-encode of the output is not stable');
  if (problems.length) {
    if (dll) { const probe = await probeRewriteSafety(bytes, { document: before, writer: 'dll' }); if (!probe.safe) fail('E_JWW_REWRITE_UNSAFE', probe.reasons.join('; ')); }
    fail('E_JWW_EDIT_VERIFY', problems.join('; '));
  }
  return { bytes: output, ir: toIR(output, after),
    receipt: { sourceHash, outputHash: hash(output), ops: normalized.ops, created: plan.created, verified: true, byteExact: Buffer.compare(bytes, output) === 0,
      byteExactOutsideEdits: dll ? null : byteExactOutsideEdits(bytes, output, plan.expected), writer } };
}
