// evaluatePlan(jwwBytes, spec, rules) -> {score, subscores, checks[], findings[]}
// Deterministic numeric review of a generated plan: drafting checks read the JWW back (codec decode, no trust in the
// generator's own primitives); planning checks review the resolved geometry like a 建築士 would.
import { readFile } from 'node:fs/promises';
import { decodeJww, semanticView } from '../native/codec/jww-codec.mjs';
import { textLength } from '../native/codec/jww-ops.mjs';
import { normalizeSpec, onModule, MODULE } from './spec.mjs';
import { buildModel, EXT, INT, COLUMN } from './model.mjs';
import { SYMBOLS, itemTransform } from './symbols.mjs';
import { sub, dot, round, inRect, frameToWorld, frameRect, pointInPolygon, rectsOverlap, lineRectInterval, len } from './geometry.mjs';

export async function loadRules() { return JSON.parse(await readFile(new URL('../knowledge/office-drafting-rules.json', import.meta.url), 'utf8')); }

// Fallbacks when the rulebook lacks evaluation.pens / roomSizes.
const DEFAULT_PENS = {
  '1:0': { line: [[3], [2]] }, '1:1': { line: [[2, 4], [1]] }, '1:2': { line: [[1, 2], [1]], solid: [[10], null] }, '1:3': { line: [[4], [1]] },
  '1:4': { line: [[1], [1]] }, '1:5': { line: [[1, 2, 4, 5], [1, 2]], arc: [[1, 5], [1]] }, '1:6': { line: [[7], [1]], arc: [[7], [1]] },
  '1:7': { line: [[4], [2, 4]], arc: [[4], [2, 4]] }, '1:8': { line: [[4], [1]] }, '1:9': { line: [[1, 2], [1]], arc: [[1], [1]], text: [[2], null] },
  '1:A': { line: [[7, 8], [1, 5]], arc: [[1, 8], [1]], text: [[2], null] }, '1:B': { solid: [[10], null] }, '1:C': { line: [[112], [1]] },
  '1:D': { line: [[1], [1]], text: [[2], null] }, '1:E': { line: [[1, 4], [1, 5]], point: [[1], null], text: [[2], null] }
};
const DEFAULT_SIZES = { bedroom: 7.29, living: 16.2, toilet: 1.2, wet: 2.4, kitchen: 4.0, entrance: 1.6, corridor: 0, storage: 0, other: 0 };
const WEIGHTS = { 'layer-role-purity': 2, 'pen-per-layer': 2, 'thick-faces-on-walls': 3, 'wall-closure': 3, 'openings-cut-walls': 3, 'insulation-exterior-only': 2,
  'room-labels-inside-rooms': 2, 'dimension-sum-equals-overall': 3, 'text-style-sizes': 1, 'furniture-dashed': 1, 'renders-without-overlap': 2, 'columns-at-structure': 1, 'grid-bubbles': 1, 'fits-sheet': 2,
  'room-sizes': 2, 'corridor-width': 2, 'door-swing-clear': 3, 'sliding-door-pocket': 1, 'wet-core-grouped': 1, 'rooms-reachable': 3, 'habitable-rooms-have-windows': 2,
  'entrance-doma': 1, 'items-fit-rooms': 3, 'items-no-clash': 1, 'door-approach-clear': 2, 'circulation-ratio': 1, 'grid-module': 3, 'dimension-module': 3, 'room-module': 1 };
const PLANNING = new Set(['room-sizes', 'corridor-width', 'door-swing-clear', 'sliding-door-pocket', 'wet-core-grouped', 'rooms-reachable', 'habitable-rooms-have-windows', 'entrance-doma', 'items-fit-rooms', 'items-no-clash', 'door-approach-clear', 'circulation-ratio', 'room-module']);

function segRectHit(a, b, r) {      // does segment ab pass through the open interior of r?
  const d = sub(b, a), L = len(d); if (L < 1e-9) return inRect({ x1: r.x1 + 0.01, y1: r.y1 + 0.01, x2: r.x2 - 0.01, y2: r.y2 - 0.01 }, a);
  const iv = lineRectInterval(a, [d[0] / L, d[1] / L], { x1: r.x1 + 0.01, y1: r.y1 + 0.01, x2: r.x2 - 0.01, y2: r.y2 - 0.01 });
  return !!iv && iv[1] > 0.01 && iv[0] < L - 0.01 && Math.min(iv[1], L) - Math.max(iv[0], 0) > 0.05;
}
const pointSegDist = (p, a, b) => { const d = sub(b, a), l2 = dot(d, d); const t = l2 ? Math.max(0, Math.min(1, dot(sub(p, a), d) / l2)) : 0; return len(sub(p, [a[0] + d[0] * t, a[1] + d[1] * t])); };

/** Recover generator origin shift (memo) or fall back to the aux grid. */
function originOf(doc, view, spec) {
  const m = /origin=(-?[\d.]+),(-?[\d.]+)/u.exec(doc.header.m_strMemo ?? '');
  if (m) return [Number(m[1]), Number(m[2])];
  const s = doc.header.m_adScale[1], vx = [], hy = [];
  for (const e of view.entities) if (e.layer === '1:0' && e.kind === 'line') { const g = e.geometry; if (Math.abs(g.start[0] - g.end[0]) < 1e-9) vx.push(g.start[0] * s); else hy.push(g.start[1] * s); }
  const ex = spec.exterior.map(p => p[0]), ey = spec.exterior.map(p => p[1]);
  return [Math.min(...ex) - Math.min(...vx), Math.min(...ey) - Math.min(...hy)].map(v => -v);
}

function collect(view, doc, shift) {
  const scale = g => doc.header.m_adScale[parseInt(g, 16)], out = [];
  for (const e of view.entities) {
    const [g] = e.layer.split(':'); if (g !== '1') continue;
    const s = scale(g), M = p => [p[0] * s + shift[0], p[1] * s + shift[1]], geo = e.geometry, base = { id: e.id, layer: e.layer, kind: e.kind, color: e.pen.color, style: e.pen.style };
    if (e.kind === 'line') out.push({ ...base, a: M(geo.start), b: M(geo.end) });
    else if (e.kind === 'arc') out.push({ ...base, c: M(geo.center), r: geo.radius * s, start: geo.startRadians, sweep: geo.full ? 2 * Math.PI : geo.sweepRadians, flat: geo.flatness, tilt: geo.tiltRadians });
    else if (e.kind === 'text') {
      const at = M(geo.at), l = textLength(geo.text, geo.width, geo.spacing) * s, h = geo.height * s, vert = Math.abs(geo.angleDegrees - 90) < 1;
      out.push({ ...base, text: geo.text, height: geo.height, at, angle: geo.angleDegrees, box: vert ? { x1: at[0] - h, y1: at[1], x2: at[0], y2: at[1] + l } : { x1: at[0], y1: at[1], x2: at[0] + l, y2: at[1] + h } });
    } else if (e.kind === 'point') out.push({ ...base, at: M(geo.at) });
    else if (e.kind === 'solid') out.push({ ...base, pts: geo.points.map(M) });
    else out.push(base);
  }
  return out;
}

function quarterDisc(o) {             // swing area of a hinged door as sample points (world)
  const s = o.swingSign, Fs = s > 0 ? o.vin : o.vout, uh = o.hingeAtR0 ? o.r0 + 24 : o.r1 - 24, L = o.leaf, dir = o.hingeAtR0 ? 1 : -1;
  const vf = Fs + s * 2.5, pts = [];
  for (let a = 30; a < L - 20; a += 40) for (let b = 30; b < L - 20; b += 40) if (Math.hypot(a, b) < L - 25) pts.push(frameToWorld(o.frame, uh + dir * a, vf + s * b));
  return { pts, L, hinge: frameToWorld(o.frame, uh, vf), uh, dir, vf, s };
}
const inDisc = (d, frame, p) => { const q = sub(p, frameToWorld(frame, d.uh, d.vf)), a = dot(q, frame.t) * d.dir, b = dot(q, frame.n) * d.s; return a > 5 && b > 5 && Math.hypot(a, b) < d.L - 5; };

export function evaluatePlan(bytes, specInput, rules = {}) {
  const norm = normalizeSpec(specInput), checks = [];
  if (norm.errors.length) return { score: 0, subscores: { drafting: 0, planning: 0 }, checks: [], findings: norm.errors.map(m => ({ check: 'spec', severity: 'error', message: m })) };
  const { model: m, errors } = buildModel(norm.spec);
  if (errors.length) return { score: 0, subscores: { drafting: 0, planning: 0 }, checks: [], findings: errors.map(msg => ({ check: 'spec', severity: 'error', message: msg })) };
  const doc = decodeJww(bytes), view = semanticView(doc), shift = originOf(doc, view, norm.spec), P = collect(view, doc, shift);
  const pens = rules.evaluation?.pens ?? DEFAULT_PENS, sizes = { ...DEFAULT_SIZES, ...(rules.evaluation?.roomSizesM2 ?? {}) };
  const add = (id, total, failed, severity, details = []) => checks.push({ id, weight: WEIGHTS[id] ?? 1, total, passed: Math.max(0, total - failed), ratio: total ? Math.max(0, total - failed) / total : 1, severity, details: details.slice(0, 12) });
  const lines = l => P.filter(p => p.kind === 'line' && p.layer === l);
  const occupied = (grid, p) => { const [i, j] = grid.cellOf(p); return i >= 0 && j >= 0 && grid.at(i, j) === 1; };

  // ---- drafting ----
  { const kinds = Object.fromEntries(Object.entries(rules.layers ?? {}).map(([k, v]) => [k, new Set([...(v.kinds ?? []), ...(k === '1:2' ? ['solid'] : [])])]));
    const bad = P.filter(p => kinds[p.layer] && !kinds[p.layer].has(p.kind));
    add('layer-role-purity', P.length, bad.length, 'error', bad.map(p => `${p.id} ${p.kind} on ${p.layer}`)); }
  { const bad = P.filter(p => { const r = pens[p.layer]?.[p.kind]; if (!r) return !!pens[p.layer]; return !r[0].includes(p.color) || (r[1] && !r[1].includes(p.style)); });
    add('pen-per-layer', P.length, bad.length, 'warn', bad.map(p => `${p.id} ${p.layer} ${p.kind} c${p.color} s${p.style}`)); }
  { // finish faces: sample every 100 mm along both faces of every wall where the face is exposed
    const faces = lines('1:1').filter(p => p.color === 2), miss = [];
    let total = 0;
    for (const w of m.walls) for (const v of [w.vout, w.vin]) for (let u = 50; u < w.frame.length; u += 100) {
      const p = frameToWorld(w.frame, u, v), outside = frameToWorld(w.frame, u, v + Math.sign(v) * 2), inside = frameToWorld(w.frame, u, v - Math.sign(v) * 2);
      if (occupied(m.bodiesSolid, outside) || !occupied(m.bodies, inside) || m.dropBoxes.some(r => inRect(r, p, 1))) continue;
      total++;
      if (!faces.some(f => pointSegDist(p, f.a, f.b) < 0.6)) miss.push(`${w.id} u${Math.round(u)} v${v}`);
    }
    add('thick-faces-on-walls', total, miss.length, 'error', miss); }
  { const faces = lines('1:1').filter(p => p.color === 2), key = p => `${Math.round(p[0])},${Math.round(p[1])}`, deg = new Map();
    for (const f of faces) for (const p of [f.a, f.b]) deg.set(key(p), (deg.get(key(p)) ?? 0) + 1);
    const ends = faces.flatMap(f => [f.a, f.b]), dangling = ends.filter(p => deg.get(key(p)) < 2 && !m.dropBoxes.some(r => inRect(r, p, 1.5)) && !faces.some(f => !(f.a === p || f.b === p) && pointSegDist(p, f.a, f.b) < 0.6));
    add('wall-closure', ends.length, dangling.length, 'error', dangling.map(p => `open end at ${p.map(v => Math.round(v))}`)); }
  { const wallLayers = new Set(['1:1', '1:3', '1:4', '1:A', '1:C']), bad = [];
    for (const o of m.openings) {
      const zone = frameRect(o.frame, o.r0 + 18, o.r1 - 18, o.vout + 1, o.vin - 1);
      const hits = P.filter(p => wallLayers.has(p.layer) && (p.kind === 'line' ? segRectHit(p.a, p.b, zone) : p.kind === 'arc' && p.color === 8 ? inRect(zone, p.c) : false));
      const drawn = P.some(p => p.layer === '1:5' && p.kind === 'line' && (inRect(frameRect(o.frame, o.r0 - 1, o.r1 + 1, o.vout - 300, o.vin + 300), p.a) || inRect(frameRect(o.frame, o.r0 - 1, o.r1 + 1, o.vout - 300, o.vin + 300), p.b)));
      if (hits.length || !drawn) bad.push(`${o.id}: ${hits.length} wall primitives inside the opening${drawn ? '' : ', no 1:5 symbol'}`);
    }
    add('openings-cut-walls', m.openings.length, bad.length, 'error', bad); }
  { const ins = P.filter(p => (p.layer === '1:A' && p.color === 8) || p.layer === '1:C'), inBand = q => pointInPolygon(q, m.outer) && !pointInPolygon(q, m.inner);
    const near = (q, poly) => poly.some((a, i) => pointSegDist(q, a, poly[(i + 1) % poly.length]) < 1);
    const bad = ins.filter(p => (p.kind === 'line' ? [p.a, p.b] : [p.c]).some(q => !inBand(q) && !near(q, m.outer) && !near(q, m.inner)));
    const intHits = ins.filter(p => (p.kind === 'line' ? [[(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2]] : [p.c]).some(q => m.intRects.some(r => inRect({ x1: r.x1 + 1, y1: r.y1 + 1, x2: r.x2 - 1, y2: r.y2 - 1 }, q) && !inBand(q))));
    const extWalls = m.walls.filter(w => w.kind === 'ext'), noIns = norm.spec.options.insulation ? extWalls.filter(w => !ins.some(p => p.layer === '1:A' && p.kind === 'line' && Math.abs(dot(sub(p.a, w.frame.o), w.frame.n)) < 40 && dot(sub(p.a, w.frame.o), w.frame.t) > -1 && dot(sub(p.a, w.frame.o), w.frame.t) < w.frame.length + 1)) : [];
    add('insulation-exterior-only', ins.length + extWalls.length, bad.length + intHits.length + noIns.length, 'error', [...bad.map(p => `${p.id} outside exterior band`), ...intHits.map(p => `${p.id} in interior wall`), ...noIns.map(w => `${w.id} has no insulation`)]); }
  { const texts = P.filter(p => p.kind === 'text' && p.layer === '1:D'), bad = [];
    for (const r of m.rooms.filter(x => x.label)) {
      const t = texts.find(x => x.text === r.name && Math.hypot((x.box.x1 + x.box.x2) / 2 - r.at[0], (x.box.y1 + x.box.y2) / 2 - r.at[1]) < 300);
      if (!t) { bad.push(`${r.name}: label missing`); continue; }
      const c = [(t.box.x1 + t.box.x2) / 2, (t.box.y1 + t.box.y2) / 2];
      if (!r.contains(c)) bad.push(`${r.name}: label outside its room`);
      const area = texts.find(x => x.text === `${r.areaM2.toFixed(2)}㎡` && Math.abs((x.box.x1 + x.box.x2) / 2 - c[0]) < 50 && c[1] - x.box.y2 > 0 && c[1] - x.box.y2 < 300);
      if (!area) bad.push(`${r.name}: area text ${r.areaM2.toFixed(2)}㎡ missing/misplaced`);
    }
    add('room-labels-inside-rooms', m.rooms.filter(x => x.label).length * 2, bad.length, 'error', bad); }
  { // each dimension line: texts sum to its length and each value equals the span between the points around it
    const dl = lines('1:E').filter(p => p.color === 1 && p.style === 1), pts = P.filter(p => p.layer === '1:E' && p.kind === 'point'), tx = P.filter(p => p.layer === '1:E' && p.kind === 'text');
    let total = 0; const bad = [];
    for (const d of dl) {
      const horiz = Math.abs(d.a[1] - d.b[1]) < 0.5, ax = horiz ? 0 : 1, c = horiz ? d.a[1] : d.a[0], lo = Math.min(d.a[ax], d.b[ax]), hi = Math.max(d.a[ax], d.b[ax]);
      const onLine = pts.filter(p => Math.abs(p.at[1 - ax] - c) < 0.5 && p.at[ax] > lo - 0.5 && p.at[ax] < hi + 0.5).map(p => p.at[ax]).sort((a, b) => a - b);
      if (onLine.length < 2 || Math.abs(onLine[0] - lo) > 0.5 || Math.abs(onLine.at(-1) - hi) > 0.5) continue;    // an extension line, not a dimension line
      const labels = tx.filter(t => horiz ? Math.abs(t.angle) < 1 && Math.abs(t.at[1] - c) < 10 && t.box.x1 >= lo - 1 && t.box.x2 <= hi + 1 : Math.abs(t.angle - 90) < 1 && Math.abs(t.at[0] - c) < 10 && t.box.y1 >= lo - 1 && t.box.y2 <= hi + 1);
      total++;
      const vals = labels.map(t => Number(t.text.replace(/,/gu, ''))), sum = vals.reduce((a, b) => a + b, 0);
      let ok = Math.abs(sum - (hi - lo)) <= Math.max(1, labels.length * 0.5) && labels.length === onLine.length - 1;
      for (const t of labels) { const mid = horiz ? (t.box.x1 + t.box.x2) / 2 : (t.box.y1 + t.box.y2) / 2, i = onLine.findIndex((v, k) => k && v > mid); if (i < 1 || Math.abs(onLine[i] - onLine[i - 1] - Number(t.text.replace(/,/gu, ''))) > 1) ok = false; }
      if (!ok) bad.push(`${horiz ? 'H' : 'V'} line at ${Math.round(c)}: texts ${vals.join('+')} vs ${Math.round(hi - lo)}`);
    }
    const xs = m.poly.map(p => p[0]), ys = m.poly.map(p => p[1]), overall = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    const hasOverall = overall.map((v, k) => tx.some(t => Number(t.text.replace(/,/gu, '')) === Math.round(v) && (k === 0 ? Math.abs(t.angle) < 1 : Math.abs(t.angle - 90) < 1)));
    hasOverall.forEach((ok, k) => { total++; if (!ok) bad.push(`overall ${k ? 'depth' : 'width'} ${Math.round(overall[k])} not dimensioned`); });
    add('dimension-sum-equals-overall', total, bad.length, 'error', bad); }
  { const allowed = new Set(Object.entries(rules.textStyles ?? {}).filter(([k]) => /^\d+$/u.test(k)).map(([, v]) => v)), want = { '1:A': [3.5], '1:E': [3], '1:D': [2.1, 2.2, 2.5, 3, 3.2] };
    const texts = P.filter(p => p.kind === 'text'), bad = texts.filter(t => (allowed.size && !allowed.has(t.height)) || (want[t.layer] && !want[t.layer].includes(t.height)));
    add('text-style-sizes', texts.length, bad.length, 'warn', bad.map(t => `${t.id} "${t.text}" ${t.height}mm on ${t.layer}`)); }
  { const f = P.filter(p => p.layer === '1:7' && (p.kind === 'line' || p.kind === 'arc')), e = P.filter(p => p.layer === '1:6' && (p.kind === 'line' || p.kind === 'arc'));
    const bad = [...f.filter(p => p.style === 1), ...e.filter(p => p.style !== 1 || p.color !== 7)];
    add('furniture-dashed', f.length + e.length, bad.length, 'warn', bad.map(p => `${p.id} ${p.layer} c${p.color} s${p.style}`)); }
  { const texts = P.filter(p => p.kind === 'text'), bad = [];
    const shrink = (b, k) => ({ x1: b.x1 + k, y1: b.y1 + k, x2: b.x2 - k, y2: b.y2 - k });
    const arcPts = P.filter(p => p.layer === '1:5' && p.kind === 'arc').flatMap(a => Array.from({ length: 25 }, (_, k) => { const t = a.start + a.sweep * k / 24; return [a.c[0] + a.r * Math.cos(t), a.c[1] + a.r * Math.sin(t)]; }));
    const dimLines = P.filter(p => p.layer === '1:E' && p.kind === 'line');
    for (let i = 0; i < texts.length; i++) {
      const b = shrink(texts[i].box, 5);
      for (let j = i + 1; j < texts.length; j++) if (rectsOverlap(b, shrink(texts[j].box, 5))) bad.push(`"${texts[i].text}" overlaps "${texts[j].text}"`);
      const samples = []; for (let x = b.x1; x <= b.x2; x += 25) for (let y = b.y1; y <= b.y2; y += 25) samples.push([x, y]);
      if (samples.some(q => occupied(m.bodies, q))) bad.push(`"${texts[i].text}" on a wall`);
      if (arcPts.some(q => inRect(b, q))) bad.push(`"${texts[i].text}" crosses a door swing`);
      if (texts[i].layer !== '1:E' && dimLines.some(l => segRectHit(l.a, l.b, b))) bad.push(`"${texts[i].text}" crosses a dimension line`);
      if (texts[i].layer === '1:D' && m.items.some(it => it.label !== texts[i].text && !it.type.startsWith('ub') && rectsOverlap(b, shrink(it.rect, 10)) && it.role === 'equipment')) bad.push(`"${texts[i].text}" over equipment`);
    }
    add('renders-without-overlap', texts.length, bad.length, 'warn', bad); }
  { const sq = lines('1:2').filter(p => p.color === 2), bad = m.columns.filter(c => sq.filter(p => pointSegDist(c.at, p.a, p.b) < COLUMN / 2 + 1 && pointSegDist(c.at, p.a, p.b) > COLUMN / 2 - 1).length < 4);
    const corners = m.poly.filter(p => !m.columns.some(c => len(sub(c.at, p)) < 1));
    add('columns-at-structure', m.columns.length + m.poly.length, bad.length + corners.length, 'warn', [...bad.map(c => `column ${c.at} not drawn`), ...corners.map(p => `no column at corner ${p}`)]); }
  { const labels = P.filter(p => p.layer === '1:A' && p.kind === 'text').map(t => t.text), want = [...norm.spec.grid.xLabels, ...norm.spec.grid.yLabels];
    const bad = want.filter(l => labels.filter(x => x === l).length < 2);
    add('grid-bubbles', want.length, bad.length, 'warn', bad.map(l => `grid ${l} lacks both bubbles`)); }

  { // everything of group 1 stays inside the A3 frame above the title strip (paper mm)
    const sc = doc.header.m_adScale[1], paper = q => [(q[0] - shift[0]) / sc, (q[1] - shift[1]) / sc], ok = ([x, y]) => x >= -200 && x <= 200 && y >= -120.5 && y <= 138.5;
    const pts = P.flatMap(p => p.kind === 'line' ? [p.a, p.b] : p.kind === 'arc' ? [[p.c[0] - p.r, p.c[1] - p.r], [p.c[0] + p.r, p.c[1] + p.r]] : p.kind === 'text' ? [[p.box.x1, p.box.y1], [p.box.x2, p.box.y2]] : p.at ? [p.at] : p.pts ?? []);
    const out = pts.filter(q => !ok(paper(q)));
    add('fits-sheet', pts.length, out.length, 'error', out.slice(0, 5).map(q => `outside the sheet frame at paper ${paper(q).map(v => v.toFixed(1))}`)); }
  { // 尺モジュール: grid spacings are multiples of 455
    const g = norm.spec.grid, bad = [];
    for (const [k, ax] of [['X', g.x], ['Y', g.y]]) ax.slice(1).forEach((v, i) => { if (!onModule(v - ax[i])) bad.push(`${k}${i + 1}-${k}${i + 2} spacing ${v - ax[i]} is not a multiple of 455`); });
    add('grid-module', g.x.length + g.y.length - 2, bad.length, 'error', bad); }
  { // dimension tiers: grid-to-grid tiers carry only 455 multiples; off-module values only in the innermost opening-position tier
    const dl = lines('1:E').filter(p => p.color === 1 && p.style === 1), pts = P.filter(p => p.layer === '1:E' && p.kind === 'point'), g = norm.spec.grid;
    const xs0 = m.poly.map(p => p[0]), ys0 = m.poly.map(p => p[1]), ext = { S: Math.min(...ys0), N: Math.max(...ys0), W: Math.min(...xs0), E: Math.max(...xs0) };
    const bySide = { S: [], N: [], W: [], E: [] };
    for (const d of dl) {
      const horiz = Math.abs(d.a[1] - d.b[1]) < 0.5, ax = horiz ? 0 : 1, c = horiz ? d.a[1] : d.a[0], lo = Math.min(d.a[ax], d.b[ax]), hi = Math.max(d.a[ax], d.b[ax]);
      const on = pts.filter(p => Math.abs(p.at[1 - ax] - c) < 0.5 && p.at[ax] > lo - 0.5 && p.at[ax] < hi + 0.5).map(p => p.at[ax]).sort((a, b) => a - b);
      if (on.length < 2 || Math.abs(on[0] - lo) > 0.5 || Math.abs(on.at(-1) - hi) > 0.5) continue;
      const side = horiz ? (c < ext.S ? 'S' : 'N') : (c < ext.W ? 'W' : 'E'), origin = horiz ? g.x[0] : g.y[0];
      bySide[side].push({ dist: Math.abs(c - ext[side]), pure: on.every(v => onModule(v, origin)), vals: on.slice(1).map((v, i) => Math.round(v - on[i])) });
    }
    let total = 0; const bad = [];
    for (const [side, ls] of Object.entries(bySide)) {
      ls.sort((a, b) => a.dist - b.dist);
      ls.forEach((l, i) => { total++; if (!l.pure && (i > 0 || ls.length < 2 || !ls.slice(1).some(x => x.pure && x.vals.length > 1))) bad.push(`${side} tier ${i + 1}: non-module values ${l.vals.filter(v => v % MODULE).join(', ')} outside a separate opening-position tier`); });
    }
    add('dimension-module', total, bad.length, 'error', bad); }
  // ---- planning ----
  { const bad = [];
    for (const r of m.rooms) {
      const min = sizes[r.kind] ?? 0;
      if (r.areaM2 + 1e-9 < min) bad.push(`${r.name}: ${r.areaM2}㎡ (${r.jo}帖) < ${min}㎡ for ${r.kind}`);
      if (['bedroom', 'living'].includes(r.kind) && r.clear && Math.min(r.clear.bbox.x2 - r.clear.bbox.x1, r.clear.bbox.y2 - r.clear.bbox.y1) < 2200) bad.push(`${r.name}: narrow side ${Math.round(Math.min(r.clear.bbox.x2 - r.clear.bbox.x1, r.clear.bbox.y2 - r.clear.bbox.y1))} mm < 2200`);
      if (r.kind === 'toilet' && r.clear && Math.min(r.clear.bbox.x2 - r.clear.bbox.x1, r.clear.bbox.y2 - r.clear.bbox.y1) < 750) bad.push(`${r.name}: clear width < 750`);
    }
    add('room-sizes', m.rooms.length, bad.length, 'warn', bad); }
  { const total = m.rooms.reduce((a, r) => a + r.areaM2, 0), circ = m.rooms.filter(r => r.kind === 'corridor').reduce((a, r) => a + r.areaM2, 0), ratio = total ? circ / total : 0;
    add('circulation-ratio', 1, ratio > 0.12 ? 1 : 0, 'warn', ratio > 0.12 ? [`corridors/halls ${circ.toFixed(2)}㎡ = ${(ratio * 100).toFixed(1)}% of floor (> 12%)`] : []); }
  { // rooms planned in grid units (centre-to-centre multiples of 455); report 帖 by module
    const bad = m.rooms.filter(r => r.bbox && (!onModule(r.bbox.x2 - r.bbox.x1) || !onModule(r.bbox.y2 - r.bbox.y1))).map(r => `${r.name}: ${Math.round(r.bbox.x2 - r.bbox.x1)}x${Math.round(r.bbox.y2 - r.bbox.y1)} not in 455 units`);
    const cor = m.rooms.filter(r => r.kind === 'corridor' && r.clear && r.clear.minWidth + 130 < 910 - 0.5).map(r => `${r.name}: corridor ${r.clear.minWidth + 130} c/c < 910`);
    add('room-module', m.rooms.length, bad.length + cor.length, 'warn', [...bad, ...cor]); }
  { const cs = m.rooms.filter(r => r.kind === 'corridor'), bad = cs.filter(r => !r.clear || r.clear.minWidth < 780);
    add('corridor-width', cs.length, bad.length, 'warn', bad.map(r => `${r.name}: clear ${r.clear?.minWidth ?? '?'} mm < 780`)); }
  { const doors = m.openings.filter(o => o.type === 'door-swing' || o.type === 'entrance-door'), discs = doors.map(o => ({ o, d: quarterDisc(o) })), bad = [];
    for (const { o, d } of discs) {
      if (d.pts.some(p => occupied(m.bodiesSolid, p))) bad.push(`${o.id}: swing hits a wall`);
      for (const { o: o2, d: d2 } of discs) if (o2 !== o && o.id < o2.id && d.pts.some(p => inDisc(d2, o2.frame, p))) bad.push(`${o.id} and ${o2.id}: swings overlap`);
      for (const it of m.items) if (d.pts.some(p => pointInPolygon(p, it.corners))) bad.push(`${o.id}: swing hits ${it.type}`);
      if (o.type === 'entrance-door' && o.swingSign > 0) bad.push(`${o.id}: entrance door opens inward (office practice: outward)`);
    }
    add('door-swing-clear', doors.length, new Set(bad.map(b => b.split(':')[0])).size, 'error', bad); }
  { const sl = m.openings.filter(o => o.type === 'door-sliding'), bad = [];
    for (const o of sl) {
      const w = m.walls.find(x => x.id === o.wall), Lf = o.r1 - o.r0 - 48, [a, b] = o.slideToR0 ? [o.r0 - Lf, o.r0] : [o.r1, o.r1 + Lf];
      const blocked = a < -1 || b > w.frame.length + 1 || w.junctions.some(j => j > a - 65 && j < b + 65) || m.openings.some(x => x !== o && x.wall === w.id && x.r1 + 65 > a && x.r0 - 65 < b);
      if (blocked) bad.push(`${o.id}: no solid wall for the open leaf (${Math.round(Lf)} mm)`);
    }
    add('sliding-door-pocket', sl.length, bad.length, 'warn', bad); }
  { const adj = (A, B) => A.cells.some(([i, j]) => B.cells.some(([k, l]) => Math.abs(i - k) + Math.abs(j - l) === 1));
    const bath = m.rooms.filter(r => /浴室|UB|バス/u.test(r.name)), wash = m.rooms.filter(r => /洗面|脱衣/u.test(r.name)), wc = m.rooms.filter(r => r.kind === 'toilet'), bad = [];
    for (const b of bath) if (!wash.some(w => adj(b, w))) bad.push(`${b.name} is not next to 洗面/脱衣`);
    const ctr = r => r.bbox ? [(r.bbox.x1 + r.bbox.x2) / 2, (r.bbox.y1 + r.bbox.y2) / 2] : [0, 0];
    for (const t of wc) if (wash.length && !wash.some(w => len(sub(ctr(t), ctr(w))) < 4600)) bad.push(`${t.name} is far from the wet core`);
    add('wet-core-grouped', bath.length + wc.length, bad.length, 'warn', bad); }
  { // region graph through openings; open-plan rooms in one region are connected
    const roomAt = p => m.rooms.find(r => r.contains(p)), edges = new Map(), link = (a, b) => { if (!a || !b || a === b) return; (edges.get(a) ?? edges.set(a, new Set()).get(a)).add(b); (edges.get(b) ?? edges.set(b, new Set()).get(b)).add(a); };
    for (const a of m.rooms) for (const b of m.rooms) if (a !== b && a.region && a.region === b.region) link(a, b);
    let entrance = null;
    for (const o of m.openings) {
      const p1 = frameToWorld(o.frame, o.u, o.vin + 200), p2 = frameToWorld(o.frame, o.u, o.vout - 200);
      if (o.type === 'window-sliding') continue;
      if (o.wallKind === 'ext') { if (o.type === 'entrance-door') entrance = roomAt(p1) ?? entrance; continue; }
      link(roomAt(p1), roomAt(p2));
    }
    entrance ??= m.rooms.find(r => r.kind === 'entrance');
    const seen = new Set(entrance ? [entrance] : []), q = [...seen];
    while (q.length) for (const n of edges.get(q.shift()) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
    const bad = m.rooms.filter(r => !seen.has(r));
    add('rooms-reachable', m.rooms.length, bad.length, 'error', [...(entrance ? [] : ['no entrance door / entrance room']), ...bad.map(r => `${r.name} unreachable from the entrance`)]); }
  { const hab = m.rooms.filter(r => r.kind === 'living' || r.kind === 'bedroom'), wins = m.openings.filter(o => o.type === 'window-sliding' || (o.type === 'door-swing' && o.wallKind === 'ext'));
    const bad = hab.filter(r => !wins.some(o => r.contains(frameToWorld(o.frame, o.u, o.vin + 200))));
    add('habitable-rooms-have-windows', hab.length, bad.length, 'error', bad.map(r => `${r.name} has no window`)); }
  { const ent = m.rooms.filter(r => r.kind === 'entrance'), bad = [];
    for (const r of ent) {
      if (!r.doma) { bad.push(`${r.name}: no doma`); continue; }
      const [x1, y1, x2, y2] = r.doma, box = { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
      const hatch = lines('1:8').filter(p => inRect(box, p.a, 1) && inRect(box, p.b, 1));
      if (hatch.length < 2) bad.push(`${r.name}: doma hatch missing`);
    }
    if (!m.openings.some(o => o.type === 'entrance-door')) bad.push('no entrance-door');
    add('entrance-doma', ent.length + 1, bad.length, 'warn', bad); }
  { const bad = [];
    for (const it of m.items) {
      const c = it.at, pts = [...it.corners.map(p => [p[0] + Math.sign(c[0] - p[0]) * 5, p[1] + Math.sign(c[1] - p[1]) * 5]), c];
      for (let k = 0; k < 4; k++) { const a = it.corners[k], b = it.corners[(k + 1) % 4]; for (let n = 1; n < 10; n++) { const t = n / 10; pts.push([a[0] + (b[0] - a[0]) * t + Math.sign(c[0] - a[0]) * 5, a[1] + (b[1] - a[1]) * t + Math.sign(c[1] - a[1]) * 5]); } }
      if (pts.some(p => occupied(m.bodiesSolid, p))) bad.push(`${it.type} at ${it.at}: overlaps a wall`);
      else if (!pts.every(p => pointInPolygon(p, m.inner))) bad.push(`${it.type} at ${it.at}: outside the building`);
      else { const rooms = new Set(pts.map(p => m.rooms.find(r => r.contains(p))?.region ?? 'none')); if (rooms.size > 1) bad.push(`${it.type} at ${it.at}: straddles rooms`); }
    }
    add('items-fit-rooms', m.items.length, bad.length, 'error', bad); }
  { const bad = [];
    for (let i = 0; i < m.items.length; i++) for (let j = i + 1; j < m.items.length; j++) {
      const A = m.items[i], B = m.items[j];
      if (rectsOverlap(A.rect, B.rect, 5) && (A.corners.some(p => pointInPolygon(p, B.corners)) || B.corners.some(p => pointInPolygon(p, A.corners)) || pointInPolygon(A.at, B.corners) || pointInPolygon(B.at, A.corners))) bad.push(`${A.type} overlaps ${B.type}`);
    }
    for (const k of m.items.filter(x => x.type.startsWith('kitchen'))) {          // work aisle in front of the counter
      const a = k.rotation * Math.PI / 180, fwd = [-Math.sin(a), Math.cos(a)], [w, d] = k.size, side = [Math.cos(a), Math.sin(a)];
      const zone = [[-w / 2, d / 2], [w / 2, d / 2], [w / 2, d / 2 + 800], [-w / 2, d / 2 + 800]].map(([x, y]) => [k.at[0] + side[0] * x + fwd[0] * y, k.at[1] + side[1] * x + fwd[1] * y]);
      const shrunk = zone.map(p => [p[0] + Math.sign(k.at[0] - p[0]) * 5, p[1] + Math.sign(k.at[1] - p[1]) * 5]);
      for (const it of m.items) if (it !== k && (it.corners.some(p => pointInPolygon(p, shrunk)) || shrunk.some(p => pointInPolygon(p, it.corners)))) bad.push(`kitchen aisle < 800 (blocked by ${it.type})`);
      const samples = []; for (let n = 1; n < 10; n++) for (let q = 1; q < 4; q++) samples.push([zone[0][0] + (zone[1][0] - zone[0][0]) * n / 10 + (zone[3][0] - zone[0][0]) * q / 4, zone[0][1] + (zone[1][1] - zone[0][1]) * n / 10 + (zone[3][1] - zone[0][1]) * q / 4]);
      if (samples.some(p => occupied(m.bodiesSolid, p))) bad.push('kitchen aisle < 800 (wall)');
    }
    for (const b of m.items.filter(x => x.type.startsWith('bed'))) {
      const T = itemTransform(b.at, b.rotation), [w, d] = b.size, head = [[-w / 2, -d / 2 - 250], [w / 2, -d / 2 - 250], [w / 2, -d / 2 + 5], [-w / 2, -d / 2 + 5]].map(T.apply);
      const hr = { x1: Math.min(...head.map(p => p[0])), y1: Math.min(...head.map(p => p[1])), x2: Math.max(...head.map(p => p[0])), y2: Math.max(...head.map(p => p[1])) };
      for (const o of m.openings.filter(x => x.type === 'window-sliding')) if (rectsOverlap(hr, frameRect(o.frame, o.r0, o.r1, o.vout, o.vin + 10), 5)) bad.push(`${b.type} at ${b.at}: headboard against window ${o.id}`);
    }
    add('items-no-clash', m.items.length + m.items.filter(x => x.type.startsWith('kitchen') || x.type.startsWith('bed')).length, bad.length, 'warn', bad); }
  { const bad = [], ops = m.openings.filter(o => o.type !== 'window-sliding');
    for (const o of ops) {
      const [z0, z1] = o.type === 'entrance-door' ? (o.hingeAtR0 ? [o.r0 + 24, o.r0 + 24 + o.leaf] : [o.r1 - 24 - o.leaf, o.r1 - 24]) : [o.r0 + 24, o.r1 - 24];   // in front of the leaf, not the fixed panel
      const zones = [frameRect(o.frame, z0, z1, o.vin, o.vin + 600)];
      if (o.wallKind === 'int') zones.push(frameRect(o.frame, z0, z1, o.vout - 600, o.vout));
      for (const z of zones) for (const it of m.items) {
        if (!it.type.startsWith('ub') && rectsOverlap(z, it.rect, 5)) bad.push(`${o.id}: approach blocked by ${it.type}`);
        const tub = SYMBOLS[it.type]?.tubZone;
        if (tub) { const T = itemTransform(it.at, it.rotation), c = [[tub[0], tub[1]], [tub[2], tub[1]], [tub[2], tub[3]], [tub[0], tub[3]]].map(T.apply); const r = { x1: Math.min(...c.map(p => p[0])), y1: Math.min(...c.map(p => p[1])), x2: Math.max(...c.map(p => p[0])), y2: Math.max(...c.map(p => p[1])) };
          if (rectsOverlap(z, r, 5)) bad.push(`${o.id}: bath entry opens onto the tub (rotate the UB)`); }
      }
    }
    add('door-approach-clear', ops.length, new Set(bad.map(b => b.split(':')[0])).size, 'error', bad); }

  const subscore = set => { const cs = checks.filter(c => set(c.id)), w = cs.reduce((s, c) => s + c.weight, 0); return w ? round(cs.reduce((s, c) => s + c.weight * c.ratio, 0) / w * 100, 10) : 100; };
  const drafting = subscore(id => !PLANNING.has(id)), planning = subscore(id => PLANNING.has(id));
  const findings = checks.filter(c => c.ratio < 1).flatMap(c => c.details.length ? c.details.map(d => ({ check: c.id, severity: c.severity, message: d })) : [{ check: c.id, severity: c.severity, message: `${c.total - c.passed}/${c.total} failed` }]);
  const penalty = Math.min(20, findings.filter(f => f.severity === 'error').length * 2);
  return { score: round(Math.max(0, 0.6 * drafting + 0.4 * planning - penalty), 10), subscores: { drafting, planning, errorPenalty: penalty }, origin: shift,
    rooms: m.rooms.map(r => ({ name: r.name, kind: r.kind, areaM2: r.areaM2, jo: r.jo, clearMin: r.clear?.minWidth ?? null })), checks, findings };
}
export { EXT, INT };
