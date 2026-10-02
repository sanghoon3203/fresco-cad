// L4 regression corpus: does the real Jw_cad open what the edit engine writes, and does the edit show up where expected?
//   node tools/jw-regress.mjs [--out <dir>] [--block <jww with blocks>] [--only <case,...>] [--wait 15000] [--stable 4] [--no-jw]
// For each op kind / entity kind a small JWW is generated (base drawing from generator/examples, edited with applyPatchV2 at
// save level = L1+L2+L3), then opened in Jw_cad via tools/jw-visual.ps1 -Mode shot (PrintWindow of the Jw_cad window only;
// never a desktop capture) before and after the edit. The Jw_cad pixel diff must be non-empty and localized; our own renderer
// (tools/render-png.mjs) gives the expected change region for comparison. Generated plans (generator/examples/*.json) are
// opened as-is. Report: <out>/report.json + report.md (default <repo>/outputs/l4, untracked). See docs/jw-assistant/verification.md.
import { readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '../native/jww.mjs';
import { applyPatchV2 } from '../native/jww-edit.mjs';
import { codecDocument } from '../native/verify.mjs';
import { decodeJww, encodeJww, semanticView } from '../native/codec/jww-codec.mjs';
import { applyOps } from '../native/codec/jww-ops.mjs';
import { flattenDrawing } from '../native/render/flatten.mjs';
import { toIR } from '../native/jww-pipeline.mjs';
import { drawPlan } from '../generator/draw-plan.mjs';
import { closeSharedWorker } from '../native/jww-worker.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const addon = path.resolve(here, '..'), repo = path.resolve(addon, '../..');
const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) { const k = args[i].replace(/^--/u, ''); opt[k] = args[i + 1]?.startsWith('--') || args[i + 1] === undefined ? true : args[++i]; }
const OUT = path.resolve(opt.out ?? path.join(repo, 'outputs/l4'));
const WAIT = Number(opt.wait ?? 15000), STABLE = Number(opt.stable ?? 4), JW = !opt['no-jw'];
const BLOCK = opt.block ?? process.env.FRESCO_JWW_BLOCK_FIXTURE ?? null;
const ONLY = opt.only ? new Set(String(opt.only).split(',')) : null;
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const node = process.execPath;
const patchFor = (bytes, ops) => ({ schemaVersion: 2, sourceHash: hash(bytes), units: 'model-mm', ops, rationale: 'L4 regression', needsClarification: null });
const noSet = { start: null, end: null, at: null, center: null, radius: null, startAngle: null, sweepAngle: null, text: null, height: null, width: null, angle: null };
const noPen = { color: null, style: null, width: null };
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

async function edit(bytes, ops) {
  const view = codecDocument(decodeJww(bytes));
  const r = await applyPatchV2(bytes, patchFor(bytes, ops), { ir: toIR(bytes, view), level: 'save' });
  return { bytes: r.bytes, verification: r.receipt.verification.map(({ level, ok, durationMs }) => ({ level, ok, durationMs })) };
}
/** Keep a small, varied subset of entities (Jw_cad on the test PC draws slowly; small files keep captures reliable). */
async function reduce(bytes, keep) {
  const view = codecDocument(decodeJww(bytes)), kept = new Set(), quota = { ...keep };
  view.entities.forEach((e, i) => { if ((quota[e.type] ?? 0) > 0) { quota[e.type]--; kept.add(i); } });
  const drop = view.entities.map((e, i) => e.id).filter((id, i) => !kept.has(i));
  // Fixture preparation (Patch v2 caps ids per patch): the codec deletes directly; the reduced file is itself opened in Jw_cad.
  return drop.length ? encodeJww(applyOps(decodeJww(bytes), [{ op: 'delete', ids: drop }]).doc) : bytes;
}

// ---- cases -----------------------------------------------------------------------------------------------------------
function opCases(base) {
  const v = codecDocument(decodeJww(base)), first = (type, n = 0) => v.entities.filter(e => e.type === type)[n]?.id;
  const line = first('JwwSen', 3), line2 = first('JwwSen', 7), text = first('JwwMoji'), layerOf = id => { const p = v.entities.find(e => e.id === id).props; return `${p.m_nGLayer.toString(16).toUpperCase()}:${p.m_nLayer.toString(16).toUpperCase()}`; };
  const otherLayer = id => { const [g, l] = layerOf(id).split(':'); return `${g}:${((parseInt(l, 16) + 1) % 16).toString(16).toUpperCase()}`; };
  const L = layerOf(line);
  return [
    ['translate-line', 'translate', 'line', [{ op: 'translate', ids: [line], dx: 2000, dy: 1500 }]],
    ['delete-line', 'delete', 'line', [{ op: 'delete', ids: [line] }]],
    ['modify-line', 'modify', 'line', [{ op: 'modify', id: line, set: { ...noSet, end: [0, 0] } }]],
    ['modify-text', 'modify', 'text', [{ op: 'modify', id: text, set: { ...noSet, text: '変更テキスト ABC' } }]],
    ['add-line', 'add', 'line', [{ op: 'add', tempId: null, entity: { kind: 'line', layer: L, start: [0, 0], end: [3000, 2000], pen: { color: 2, style: null, width: null } } }]],
    ['add-text', 'add', 'text', [{ op: 'add', tempId: null, entity: { kind: 'text', layer: L, at: [500, 500], text: '洋室 6帖', height: null, width: null, spacing: null, angle: null, style: 5, color: null } }]],
    ['add-arc', 'add', 'arc', [{ op: 'add', tempId: null, entity: { kind: 'arc', layer: L, center: [1500, 1500], radius: 1200, startAngle: 0, sweepAngle: 270, flatness: null, tilt: null, pen: noPen } }]],
    ['add-point', 'add', 'point', [{ op: 'add', tempId: null, entity: { kind: 'point', layer: L, at: [2500, 500], pen: noPen } }]],
    ['setLayer-line', 'setLayer', 'line', [{ op: 'setLayer', ids: [line2], layer: otherLayer(line2) }]],
    ['setPen-line', 'setPen', 'line', [{ op: 'setPen', ids: [line2], pen: { color: 6, style: 2, width: null } }]]
  ].map(([id, op, kind, ops]) => ({ id, op, kind, ops, expectVisible: op !== 'setLayer' })); // same-scale layer move: nothing to see
}

// ---- Jw_cad + renderer ----------------------------------------------------------------------------------------------
async function shot(jww, png) {
  const t0 = Date.now();
  try {
    const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'jw-visual.ps1'), '-Mode', 'shot',
      '-JwwPath', jww, '-PngPath', png, '-WaitMs', String(WAIT), '-StableFrames', String(STABLE)], { windowsHide: true, timeout: WAIT + 200000, maxBuffer: 1 << 20 });
    // jw-visual prints paths through the console code page (mangled for non-ASCII paths): keep our own path.
    const info = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
    return { ok: true, ms: Date.now() - t0, frames: info.frames, png };
  } catch (error) { return { ok: false, ms: Date.now() - t0, error: (String(error.stderr ?? '').match(/E_VISUAL_[A-Z_]+/u)?.[0]) ?? String(error.message).slice(0, 200) }; }
}
// Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced: what System.Drawing writes) so the pixel diff runs in Node
// (jw-visual.ps1 -Mode diff loops per pixel in PowerShell: about a minute per image pair on the test PC).
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('E_PNG');
  let at = 8, w = 0, h = 0, type = 0; const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), kind = buf.toString('latin1', at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9]; if (data[8] !== 8 || data[12] !== 0 || ![2, 6].includes(type)) throw new Error('E_PNG_FORMAT'); }
    else if (kind === 'IDAT') idat.push(data); else if (kind === 'IEND') break;
    at += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3, stride = w * bpp, raw = inflateSync(Buffer.concat(idat)), px = Buffer.alloc(w * h * 3);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let p = line[i];
      if (f === 1) p += a; else if (f === 2) p += b; else if (f === 3) p += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = p & 0xff;
    }
    for (let x = 0; x < w; x++) cur.copy(px, (y * w + x) * 3, x * bpp, x * bpp + 3);
    [prev, cur] = [cur, prev];
  }
  return { w, h, px };
}
/** { changedPixels, totalPixels, changedBox:[x1,y1,x2,y2]|null, width, height } (same fields as jw-visual.ps1 -Mode diff). */
async function diff(a, b) {
  const A = decodePng(await readFile(a)), B = decodePng(await readFile(b));
  if (A.w !== B.w || A.h !== B.h) throw new Error('E_VISUAL_SIZE_MISMATCH');
  let changed = 0, x1 = A.w, y1 = A.h, x2 = -1, y2 = -1;
  for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
    const i = (y * A.w + x) * 3;
    if (A.px[i] !== B.px[i] || A.px[i + 1] !== B.px[i + 1] || A.px[i + 2] !== B.px[i + 2]) { changed++; if (x < x1) x1 = x; if (y < y1) y1 = y; if (x > x2) x2 = x; if (y > y2) y2 = y; }
  }
  return { changedPixels: changed, totalPixels: A.w * A.h, changedBox: x2 >= 0 ? [x1, y1, x2, y2] : null, width: A.w, height: A.h };
}
const bboxOf = bytes => flattenDrawing(semanticView(decodeJww(bytes))).bbox;
const union = (a, b) => !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
async function render(jww, png, bbox) {
  await run(node, [path.join(here, 'render-png.mjs'), jww, png, '--bbox', bbox.join(','), '--max', '1600'], { windowsHide: true, timeout: 200000, maxBuffer: 1 << 20 });
}
// Jw_cad window layout at -Width 1600 -Height 1000: the drawing area excludes the title/menu/toolbar (top), the tool palettes
// (left) and the status bar (bottom; it repaints a clock-like field, see the baseline repeatability diff).
const CROP = (opt.crop ? String(opt.crop).split(',').map(Number) : [166, 88, 1590, 968]);
async function diffIn(a, b, box) {
  const A = decodePng(await readFile(a)), B = decodePng(await readFile(b));
  let changed = 0, x1 = A.w, y1 = A.h, x2 = -1, y2 = -1;
  for (let y = box[1]; y < Math.min(box[3], A.h); y++) for (let x = box[0]; x < Math.min(box[2], A.w); x++) {
    const i = (y * A.w + x) * 3;
    if (A.px[i] !== B.px[i] || A.px[i + 1] !== B.px[i + 1] || A.px[i + 2] !== B.px[i + 2]) { changed++; if (x < x1) x1 = x; if (y < y1) y1 = y; if (x > x2) x2 = x; if (y > y2) y2 = y; }
  }
  return { changedPixels: changed, changedBox: x2 >= 0 ? [x1, y1, x2, y2] : null };
}
// The paper frame (Jw_cad's dotted sheet border) in a capture: leftmost/rightmost columns of the drawing area that are
// non-white over a large part of the height. Gives the paper-mm -> pixel mapping (paper centred on the view origin).
async function paperFrame(png, paperWidthMm) {
  const { w, px } = decodePng(await readFile(png)), counts = [];
  for (let x = CROP[0] + 2; x < CROP[2] - 2; x++) { let n = 0; for (let y = CROP[1]; y < CROP[3]; y++) { const i = (y * w + x) * 3; if (px[i] < 230 || px[i + 1] < 230 || px[i + 2] < 230) n++; } counts.push([x, n]); }
  const tall = counts.filter(([, n]) => n > 0.3 * (CROP[3] - CROP[1]));
  if (tall.length < 2 || !paperWidthMm) return null;
  const xl = tall[0][0], xr = tall.at(-1)[0];
  if (xr - xl < 200) return null;
  return { xl, xr, k: (xr - xl) / paperWidthMm, cx: (xl + xr) / 2, cy: (CROP[1] + CROP[3]) / 2 };
}
const PAPER_MM = [1189, 841, 594, 420, 297]; // m_nZumen 0..4 = A0..A4 landscape width
const paperWidth = bytes => PAPER_MM[decodeJww(bytes).header.m_nZumen] ?? null;
// Renderer diff box (pixels of render-png output for `bbox` with its 5 mm margin) -> paper mm -> expected Jw_cad pixels.
function expectedJwBox(rd, bbox, frame) {
  if (!rd.changedBox || !frame) return null;
  const s = rd.width / (bbox[2] - bbox[0] + 10), mm = ([px, py]) => [px / s + bbox[0] - 5, bbox[3] + 5 - py / s];
  const [ax, ay] = mm([rd.changedBox[0], rd.changedBox[1]]), [bx, by] = mm([rd.changedBox[2] + 1, rd.changedBox[3] + 1]);
  const X = x => frame.cx + x * frame.k, Y = y => frame.cy - y * frame.k;
  return [X(ax), Y(ay), X(bx), Y(by)].map(Math.round);
}
const pad = (b, p) => [b[0] - p, b[1] - p, b[2] + p, b[3] + p];
const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const area = b => b ? (b[2] - b[0] + 1) * (b[3] - b[1] + 1) : 0;

async function compare(c, dir, beforeJww, afterJww, beforeShot) {
  const beforeBytes = await readFile(beforeJww), bbox = union(bboxOf(beforeBytes), bboxOf(await readFile(afterJww)));
  await render(beforeJww, path.join(dir, 'render-before.png'), bbox); await render(afterJww, path.join(dir, 'render-after.png'), bbox);
  const rd = await diff(path.join(dir, 'render-before.png'), path.join(dir, 'render-after.png'));
  c.renderer = { changedPixels: rd.changedPixels, box: rd.changedBox };
  if (!JW) { c.verdict = rd.changedPixels > 0 ? 'rendered-only (renderer change visible)' : 'rendered-only (no renderer change)'; return; }
  const after = await shot(afterJww, path.join(dir, 'jw-after.png'));
  c.jwAfter = after;
  if (!beforeShot?.ok || !after.ok) { c.verdict = after.ok ? 'no-baseline' : `jw-capture-failed (${after.error})`; return; }
  const whole = await diff(beforeShot.png, after.png), jd = await diffIn(beforeShot.png, after.png, CROP);
  const frame = await paperFrame(beforeShot.png, paperWidth(beforeBytes)), expected = expectedJwBox(rd, bbox, frame);
  c.jw = { changedPixelsWindow: whole.changedPixels, changedPixels: jd.changedPixels, box: jd.changedBox, areaFraction: +(area(jd.changedBox) / area(CROP)).toFixed(4) };
  c.expectedJwBox = expected; c.paperFrame = frame;
  const changed = jd.changedPixels > 0, localized = changed && c.jw.areaFraction < 0.25;
  const located = !expected || !changed ? null : overlaps(pad(jd.changedBox, 6), pad(expected, 12));
  c.located = located;
  c.verdict = !changed ? (c.expectVisible === false || rd.changedPixels === 0 ? 'accepted' : 'not-visible-in-capture (unverified)')
    : !localized ? 'change-not-localized' : located === false ? 'change-elsewhere' : 'accepted';
}

// ---- main ------------------------------------------------------------------------------------------------------------
await mkdir(OUT, { recursive: true });
const started = Date.now(), report = { generatedAt: new Date().toISOString(), host: process.platform, waitMs: WAIT, stableFrames: STABLE, jwcad: JW, baselines: {}, cases: [], plans: [] };
const want = id => !ONLY || ONLY.has(id);
try {
  // Base: the smallest example plan, reduced to a varied ~200-entity drawing.
  const examples = (await readdir(path.join(addon, 'generator/examples'))).filter(f => f.endsWith('.json')).sort();
  const full = Buffer.from(drawPlan(JSON.parse(await readFile(path.join(addon, 'generator/examples/plan-1ldk-46.json'), 'utf8'))).bytes);
  const base = await reduce(full, { JwwSen: 160, JwwMoji: 12, JwwEnko: 12, JwwTen: 6, JwwSolid: 4 });
  const baseDir = path.join(OUT, 'base'); await rm(baseDir, { recursive: true, force: true }); await mkdir(baseDir, { recursive: true });
  const baseJww = path.join(baseDir, 'base.jww'); await writeFile(baseJww, base);
  log(`base ${base.length} bytes`);
  let baseShot = null;
  if (JW) {
    baseShot = await shot(baseJww, path.join(baseDir, 'jw-before.png'));
    const again = await shot(baseJww, path.join(baseDir, 'jw-before-repeat.png'));
    report.baselines.base = { first: baseShot, repeat: again };
    if (baseShot.ok && again.ok) report.baselines.base.repeatDiff = { window: await diff(baseShot.png, again.png), drawingArea: await diffIn(baseShot.png, again.png, CROP) };
    log('baseline', JSON.stringify(report.baselines.base.repeatDiff ?? baseShot));
  }
  for (const c of opCases(base)) {
    if (!want(c.id)) continue;
    const dir = path.join(OUT, c.id); await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
    const entry = { id: c.id, op: c.op, kind: c.kind, expectVisible: c.expectVisible };
    try {
      const out = await edit(base, c.ops); entry.verification = out.verification;
      const jww = path.join(dir, 'after.jww'); await writeFile(jww, out.bytes);
      await compare(entry, dir, baseJww, jww, baseShot);
    } catch (error) { entry.verdict = `error ${error.code ?? ''} ${String(error.detail ?? error.message).slice(0, 200)}`; }
    report.cases.push(entry); log(c.id, entry.verdict, JSON.stringify(entry.jw ?? {}));
  }
  // Block instance translate: a reduced copy of a drawing with block definitions (block defs/instances kept).
  if (BLOCK && want('translate-block')) {
    const dir = path.join(OUT, 'translate-block'); await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
    const entry = { id: 'translate-block', op: 'translate', kind: 'block' };
    try {
      const src = await reduce(await readFile(BLOCK), { JwwBlock: 50, JwwSen: 150, JwwMoji: 5, JwwEnko: 20 });
      const before = path.join(dir, 'before.jww'); await writeFile(before, src);
      const v = codecDocument(decodeJww(src)), blk = v.entities.find(e => e.type === 'JwwBlock');
      const out = await edit(src, [{ op: 'translate', ids: [blk.id], dx: 3000, dy: 0 }]); entry.verification = out.verification;
      const after = path.join(dir, 'after.jww'); await writeFile(after, out.bytes);
      const bs = JW ? await shot(before, path.join(dir, 'jw-before.png')) : null;
      report.baselines.block = bs;
      await compare(entry, dir, before, after, bs);
    } catch (error) { entry.verdict = `error ${error.code ?? ''} ${String(error.detail ?? error.message).slice(0, 200)}`; }
    report.cases.push(entry); log(entry.id, entry.verdict);
  } else if (!BLOCK) report.cases.push({ id: 'translate-block', op: 'translate', kind: 'block', verdict: 'skipped (no --block / FRESCO_JWW_BLOCK_FIXTURE)' });
  // Generated plans: opened as written by the generator (no edit); Jw_cad must open and draw them.
  for (const f of examples) {
    const id = `plan-${path.basename(f, '.json')}`; if (!want(id) && !want('plans')) continue;
    const dir = path.join(OUT, id); await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
    const entry = { id, op: 'generate', kind: 'plan' };
    try {
      const r = drawPlan(JSON.parse(await readFile(path.join(addon, 'generator/examples', f), 'utf8'))), jww = path.join(dir, 'plan.jww');
      await writeFile(jww, Buffer.from(r.bytes)); entry.bytes = r.bytes.length;
      await render(jww, path.join(dir, 'render.png'), bboxOf(Buffer.from(r.bytes)));
      if (JW) { entry.jw = await shot(jww, path.join(dir, 'jw.png')); entry.verdict = entry.jw.ok ? 'opened' : `jw-capture-failed (${entry.jw.error})`; }
      else entry.verdict = 'rendered (Jw_cad not run)';
    } catch (error) { entry.verdict = `error ${error.code ?? ''} ${String(error.message).slice(0, 200)}`; }
    report.plans.push(entry); log(id, entry.verdict);
  }
} finally { await closeSharedWorker(); }
report.durationMs = Date.now() - started;
report.accepted = report.cases.filter(c => c.verdict === 'accepted').map(c => c.id);
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const fmtBox = b => b ? b.join(',') : '-';
const md = ['# L4 Jw_cad regression', '', `${report.generatedAt} · wait ${WAIT} ms · stable frames ${STABLE} · ${Math.round(report.durationMs / 1000)} s`, '',
  report.baselines.base?.repeatDiff ? `Baseline repeatability (same file captured twice): ${report.baselines.base.repeatDiff.window.changedPixels} differing pixels in the window, ${report.baselines.base.repeatDiff.drawingArea.changedPixels} in the drawing area (crop ${CROP.join(',')}).` : '', '',
  '| case | op | kind | L1-L3 | verdict | Jw_cad changed px (drawing area) | Jw_cad change box | expected box (from renderer) | located |', '|---|---|---|---|---|---|---|---|---|',
  ...report.cases.map(c => `| ${c.id} | ${c.op} | ${c.kind} | ${(c.verification ?? []).map(v => `${v.level}${v.ok ? '✓' : '✗'}`).join(' ')} | ${c.verdict} | ${c.jw?.changedPixels ?? '-'} | ${fmtBox(c.jw?.box)} | ${fmtBox(c.expectedJwBox)} | ${c.located ?? '-'} |`),
  '', '| plan | bytes | verdict | capture ms | frames |', '|---|---|---|---|---|',
  ...report.plans.map(p => `| ${p.id} | ${p.bytes ?? '-'} | ${p.verdict} | ${p.jw?.ms ?? '-'} | ${p.jw?.frames ?? '-'} |`), '',
  `Jw_cad-accepted op kinds: ${report.accepted.join(', ') || 'none'}`, ''];
await writeFile(path.join(OUT, 'report.md'), md.join('\n'));
console.log(JSON.stringify({ out: OUT, accepted: report.accepted, cases: report.cases.map(c => [c.id, c.verdict]), plans: report.plans.map(p => [p.id, p.verdict]) }));
