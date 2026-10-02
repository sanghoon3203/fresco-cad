// One building model for the whole drawing set: the plan spec (walls, openings, rooms) + a small `building` block
// (levels, roof, opening heights, foundation, section cut, build-ups). Every elevation, section and foundation
// drawing is derived from buildBuilding(spec) so heights, openings and foundation lines stay consistent.
// Numbers are the measured office conventions of practice house A (knowledge/office-drafting-rules-*.json).
import { normalizeSpec, onModule, MODULE } from './spec.mjs';
import { buildModel, COLUMN } from './model.mjs';
import { sub, dot, round, near, pointInPolygon, pointOnSegment, polygonEdges, subtractIntervals, cellGrid } from './geometry.mjs';

export const BUILDING_DEFAULTS = {
  levels: { foundationTop: 400, sill: 105, floor: 40, beamClear: 2720, eaveBeam: 180, ceiling: 2430 },
  roof: { type: 'shed', slope: 0.35, low: 'S', eaves: { low: 600, high: 270, gable: 450 }, buildUp: 82, soffitDrop: 245.8, underside: 58.3, roofing: 7 },
  openings: { head: 2000, doorHead: 2000, entranceHead: 2200, fullHeight: 1800, byId: {} },
  foundation: {
    type: 'mat', riser: 150, footingWidth: 400, footingThickness: 150, footingBottom: 660, gravel: 100, gravelWidth: 500,
    slab: 180, slabTop: 0, slabInsulation: 100, slabGravel: 100, edgeInsulation: 100, innerInsulation: 50, mortar: 15, skirt: [450, 50],
    interior: 'riser', interiorLines: null, domaSlab: 150, gradeBeamWidth: 600, manholeWidth: 600, inspection: null,
    anchor: { size: 'M12', length: 400, endOffset: 200, maxSpacing: 2730 }, postPitch: 910, postClear: 200
  },
  section: { axis: null, at: null },
  buildUps: {
    roof: ['ガルバリウム鋼板横葺き 厚0.35', 'アスファルトルーフィング 23kg', '構造用合板(野地板) 厚12', '垂木 45×60 @455'],
    wall: ['金属サイディング 厚15 (縦張り)', '横胴縁 18×45 @455 (通気層)', '透湿防水シート', '付加断熱 フェノールフォーム 厚90', '石膏板 厚9.5', '充填断熱 GW 厚105'],
    interior: ['防湿気密シート 厚0.2', '石膏ボード 厚12.5', 'ビニルクロス'],
    ceiling: ['吹込み断熱 GW 厚400', '野縁 45×45 @455', '石膏ボード 厚9.5'],
    floor: ['フローリング 厚12', '構造用合板(ネダレス) 厚28', '土台・大引 105×105'],
    foundation: ['耐圧版コンクリート 厚180', '土間下断熱 EPS 厚100', '防湿シート 厚0.2', '砕石 厚100']
  }
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const merge = (base, over) => { const o = structuredClone(base); for (const [k, v] of Object.entries(over ?? {})) o[k] = isObj(v) && isObj(o[k]) ? merge(o[k], v) : v; return o; };
const SIDE_NORMAL = { S: [0, -1], N: [0, 1], W: [-1, 0], E: [1, 0] };
export const OPPOSITE = { S: 'N', N: 'S', E: 'W', W: 'E' };
export const SIDE_NAMES = { S: '南立面図', N: '北立面図', E: '東立面図', W: '西立面図' };
/** Round a height label up to 5 mm (office labels 6,452.9 as 6,455). */
export const ceil5 = v => Math.ceil(v / 5 - 1e-9) * 5;

/** Derived levels above design GL (mm). */
export function levelsOf(b) {
  const L = b.levels, foundationTop = L.foundationTop, sillTop = foundationTop + L.sill, FL = sillTop + L.floor, beamBottom = sillTop + L.beamClear;
  const eave = beamBottom + L.eaveBeam, ceiling = FL + L.ceiling;
  return { GL: 0, foundationTop, sillTop, FL, beamBottom, eave, ceiling, eaveFromFL: eave - FL };
}

/**
 * Shed-roof geometry. s = distance along the slope from the low exterior wall centreline (s=0 at the low wall,
 * s=depth at the high wall). top(s) = eave + slope*s + buildUp/cos.
 */
export function roofOf(b, model) {
  const r = b.roof, xs = model.poly.map(p => p[0]), ys = model.poly.map(p => p[1]);
  const ext = { S: Math.min(...ys), N: Math.max(...ys), W: Math.min(...xs), E: Math.max(...xs) };
  const axis = r.low === 'S' || r.low === 'N' ? 'y' : 'x', sign = r.low === 'S' || r.low === 'W' ? 1 : -1;
  const s0 = ext[r.low], depth = Math.abs(ext[OPPOSITE[r.low]] - s0), L = levelsOf(b), cos = 1 / Math.hypot(1, r.slope);
  const sOf = p => (axis === 'y' ? p[1] - s0 : p[0] - s0) * sign;
  const lift = r.buildUp / cos;
  const top = s => L.eave + r.slope * s + lift;
  const sMin = -r.eaves.low, sMax = depth + r.eaves.high;
  return { ...r, axis, sign, s0, depth, sOf, top, lift, cos, sMin, sMax, extent: ext, maxHeight: top(sMax), maxLabel: ceil5(top(sMax)),
    beamTopAt: s => L.eave + r.slope * s, soffit: s => top(s) - r.soffitDrop, ridgeSide: OPPOSITE[r.low] };
}

/** Elevation views: which plan edges face the viewer and the horizontal axis u (left -> right as seen). */
export function facadesOf(model, b) {
  const out = {};
  const ext = model.walls.filter(w => w.kind === 'ext');
  for (const side of ['S', 'E', 'N', 'W']) {
    const nrm = SIDE_NORMAL[side];
    // viewer looks against nrm; u axis = viewer's right: S view -> +x, N -> -x, E -> +y, W -> -y
    const uDir = { S: [1, 0], N: [-1, 0], E: [0, 1], W: [0, -1] }[side];
    const u = p => dot(p, uDir), depthOf = p => dot(p, nrm);
    const faces = ext.filter(w => dot([-w.frame.n[0], -w.frame.n[1]], nrm) > 0.5).map(w => {
      const ua = u(w.a), ub = u(w.b);
      return { wall: w, u0: Math.min(ua, ub), u1: Math.max(ua, ub), depth: depthOf(w.a) };
    }).sort((p, q) => p.u0 - q.u0);
    // visible portion of each face: nearest (largest depth) wins on overlapping u ranges
    for (const f of faces) {
      const nearer = faces.filter(g => g !== f && g.depth > f.depth + 1).map(g => [g.u0 - 185, g.u1 + 185]);
      f.visible = subtractIntervals(f.u0 - 185, f.u1 + 185, nearer, 1);
    }
    const allU = model.poly.map(u);
    const openings = model.openings.filter(o => o.wallKind === 'ext' && faces.some(f => f.wall.id === o.wall)).map(o => {
      const ja = u(o.jambs[0]), jb = u(o.jambs[1]), c = (ja + jb) / 2, half = o.clear / 2;
      return { o, u0: c - half, u1: c + half, uc: c, face: faces.find(f => f.wall.id === o.wall) };
    });
    out[side] = { side, name: SIDE_NAMES[side], uDir, u, faces, uMin: Math.min(...allU), uMax: Math.max(...allU), openings };
  }
  return out;
}

/** Opening vertical extent above FL: {sill, head} (mm). */
export function openingHeights(o, b) {
  const over = b.openings.byId?.[o.id] ?? {};
  if (o.type === 'entrance-door') return { sill: over.sill ?? 0, head: over.head ?? b.openings.entranceHead };
  if (o.type.startsWith('door') || o.type === 'opening') return { sill: over.sill ?? 0, head: over.head ?? b.openings.doorHead };
  const head = over.head ?? b.openings.head, h = over.height ?? o.height ?? 1100;
  const sill = over.sill ?? (h >= b.openings.fullHeight ? 0 : head - h);
  return { sill, head: over.head ?? (h >= b.openings.fullHeight ? Math.max(head, h) : head) };
}

// ---------- foundation layout ----------
const segKey = (a, b) => `${round(a[0])},${round(a[1])}-${round(b[0])},${round(b[1])}`;
/** Split collinear touching segments into maximal runs (axis-aligned). */
function mergeSegments(segs) {
  const out = [], used = new Array(segs.length).fill(false);
  const norm = ([a, b]) => (a[0] < b[0] - 0.01 || (near(a[0], b[0], 0.01) && a[1] < b[1])) ? [a, b] : [b, a];
  const S = segs.map(norm);
  for (let i = 0; i < S.length; i++) {
    if (used[i]) continue;
    let [a, b] = S[i]; used[i] = true;
    const horiz = near(a[1], b[1], 0.5);
    for (let grew = true; grew;) {
      grew = false;
      for (let j = 0; j < S.length; j++) {
        if (used[j]) continue;
        const [c, d] = S[j];
        if (horiz ? !(near(c[1], a[1]) && near(d[1], a[1])) : !(near(c[0], a[0]) && near(d[0], a[0]))) continue;
        const [lo, hi, clo, chi] = horiz ? [a[0], b[0], c[0], d[0]] : [a[1], b[1], c[1], d[1]];
        if (clo <= hi + 0.5 && chi >= lo - 0.5) { const nlo = Math.min(lo, clo), nhi = Math.max(hi, chi); a = horiz ? [nlo, a[1]] : [a[0], nlo]; b = horiz ? [nhi, a[1]] : [a[0], nhi]; used[j] = true; grew = true; }
      }
    }
    out.push([a, b]);
  }
  return out;
}

export function foundationOf(model, b) {
  const F = b.foundation, errors = [], warnings = [];
  const ext = polygonEdges(model.poly).map(([a, c]) => ({ a, b: c, kind: 'ext' }));
  // interior lines: explicit, or every interior wall (bearing walls are drawn as walls in the plan spec)
  let intSegs = Array.isArray(F.interiorLines) ? F.interiorLines.map(l => [[l[0], l[1]], [l[2], l[3]]]) : model.walls.filter(w => w.kind === 'int').map(w => [w.a, w.b]);
  // 玄関土間: its edges inside the building get a riser (土間 is lower than the floor void)
  const doma = model.rooms.filter(r => r.doma).map(r => { const [x1, y1, x2, y2] = r.doma; return { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2), room: r.name }; });
  const domaSegs = [];
  for (const d of doma) for (const [p, q] of [[[d.x1, d.y1], [d.x2, d.y1]], [[d.x2, d.y1], [d.x2, d.y2]], [[d.x1, d.y2], [d.x2, d.y2]], [[d.x1, d.y1], [d.x1, d.y2]]]) {
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    if (ext.some(e => pointOnSegment(mid, e.a, e.b, 1))) continue;
    domaSegs.push([p, q]);
  }
  for (const [p, q] of intSegs) for (const v of [p, q]) if (!onModule(v[0], model.spec.grid.x[0]) || !onModule(v[1], model.spec.grid.y[0])) errors.push(`foundation line end ${v} off the 455 module`);
  for (const [p, q] of domaSegs) for (const v of [p, q]) if (!onModule(v[0], model.spec.grid.x[0]) || !onModule(v[1], model.spec.grid.y[0])) errors.push(`doma edge end ${v} off the 455 module`);
  // riser mode: interior lines + doma edges are risers; grade-beam mode: interior lines are beams under the slab, the doma keeps its own riser
  const grade = F.interior === 'grade-beam';
  const risers = [...ext, ...mergeSegments(grade ? domaSegs : [...intSegs, ...domaSegs]).map(([a, c]) => ({ a, b: c, kind: 'int' }))];
  const beams = grade ? mergeSegments(intSegs).map(([a, c]) => ({ a, b: c, kind: 'beam' })) : [];

  // compartments of the floor void separated by risers (cell flood fill on riser centrelines)
  const xs = [...model.poly.map(p => p[0]), ...risers.flatMap(r => [r.a[0], r.b[0]])], ys = [...model.poly.map(p => p[1]), ...risers.flatMap(r => [r.a[1], r.b[1]])];
  const grid = cellGrid(xs, ys, (x, y) => pointInPolygon([x, y], model.poly));
  const blocked = (p, q) => risers.some(r => pointOnSegment(p, r.a, r.b, 0.5) && pointOnSegment(q, r.a, r.b, 0.5));
  const comp = new Int32Array(grid.nx * grid.ny).fill(-1), comps = [];
  for (let j0 = 0; j0 < grid.ny; j0++) for (let i0 = 0; i0 < grid.nx; i0++) {
    if (!grid.at(i0, j0) || comp[j0 * grid.nx + i0] >= 0) continue;
    const id = comps.length, cells = [], stack = [[i0, j0]]; comp[j0 * grid.nx + i0] = id;
    while (stack.length) {
      const [i, j] = stack.pop(); cells.push([i, j]);
      const X = grid.xs, Y = grid.ys;
      const nb = [[i + 1, j, [X[i + 1], Y[j]], [X[i + 1], Y[j + 1]]], [i - 1, j, [X[i], Y[j]], [X[i], Y[j + 1]]], [i, j + 1, [X[i], Y[j + 1]], [X[i + 1], Y[j + 1]]], [i, j - 1, [X[i], Y[j]], [X[i + 1], Y[j]]]];
      for (const [a, c, p, q] of nb) if (a >= 0 && c >= 0 && a < grid.nx && c < grid.ny && grid.at(a, c) && comp[c * grid.nx + a] < 0 && !blocked(p, q)) { comp[c * grid.nx + a] = id; stack.push([a, c]); }
    }
    const area = cells.reduce((s, [i, j]) => s + (grid.xs[i + 1] - grid.xs[i]) * (grid.ys[j + 1] - grid.ys[j]), 0);
    const cx = cells.reduce((s, [i, j]) => s + (grid.xs[i] + grid.xs[i + 1]) / 2 * (grid.xs[i + 1] - grid.xs[i]) * (grid.ys[j + 1] - grid.ys[j]), 0) / area;
    const cy = cells.reduce((s, [i, j]) => s + (grid.ys[j] + grid.ys[j + 1]) / 2 * (grid.xs[i + 1] - grid.xs[i]) * (grid.ys[j + 1] - grid.ys[j]), 0) / area;
    const inDoma = doma.some(d => cx > d.x1 && cx < d.x2 && cy > d.y1 && cy < d.y2);
    comps.push({ id, cells, area, center: [cx, cy], doma: inDoma });
  }
  const compAt = p => { const [i, j] = grid.cellOf(p); return i >= 0 && j >= 0 && i < grid.nx && j < grid.ny ? comp[j * grid.nx + i] : -1; };

  // 人通口: spanning tree of the void compartments (doma excluded) from the inspection compartment
  const columnsOn = r => model.columns.filter(c => pointOnSegment(c.at, r.a, r.b, 1)).map(c => dot(sub(c.at, r.a), dirOf(r)));
  const voids = comps.filter(c => !c.doma);
  const inspect = F.inspection ? compAt(F.inspection) : pickInspection(model, voids, compAt);
  const manholes = [], linked = new Set([inspect]);
  const intRisers = risers.filter(r => r.kind === 'int');
  for (let guard = 0; guard < 100 && linked.size < voids.length; guard++) {
    let best = null;
    for (const r of intRisers) {
      const L = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]), d = dirOf(r), n = [-d[1], d[0]];
      // candidate positions: door/opening centres on this line first (no wall above), then free spans between columns
      const doors = model.openings.filter(o => o.wallKind === 'int' && pointOnSegment(o.at, r.a, r.b, 1)).map(o => ({ t: dot(sub(o.at, r.a), d), why: 'under-door' }));
      const cols = [0, ...columnsOn(r), L].sort((p, q) => p - q), spans = [];
      for (let i = 1; i < cols.length; i++) if (cols[i] - cols[i - 1] >= F.manholeWidth + 2 * 300) spans.push({ t: (cols[i] + cols[i - 1]) / 2, why: 'mid-span', len: cols[i] - cols[i - 1] });
      for (const c of [...doors, ...spans.sort((p, q) => q.len - p.len)]) {
        const p = [r.a[0] + d[0] * c.t, r.a[1] + d[1] * c.t], A = compAt([p[0] + n[0] * 200, p[1] + n[1] * 200]), B = compAt([p[0] - n[0] * 200, p[1] - n[1] * 200]);
        if (A < 0 || B < 0 || A === B || comps[A].doma || comps[B].doma) continue;
        if (linked.has(A) === linked.has(B)) continue;
        if (c.t - F.manholeWidth / 2 < 150 || c.t + F.manholeWidth / 2 > L - 150) continue;
        const score = (c.why === 'under-door' ? 0 : 1);
        if (!best || score < best.score) best = { riser: r, t: c.t, at: p, why: c.why, link: [A, B], score };
        break;
      }
    }
    if (!best) { warnings.push('人通口: some floor-void compartments cannot be linked (check interior foundation lines)'); break; }
    manholes.push({ at: best.at, riser: best.riser, t: best.t, width: F.manholeWidth, why: best.why, dir: dirOf(best.riser) });
    best.link.forEach(k => linked.add(k));
  }

  // anchor bolts on every riser that carries a sill (土台): 200 from corner/junction/jamb columns, <= maxSpacing between
  const anchors = [];
  const A = F.anchor;
  for (const r of risers) {
    const L = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]), d = dirOf(r);
    const holes = manholes.filter(m => m.riser === r || (pointOnSegment(m.at, r.a, r.b, 1))).map(m => { const t = dot(sub(m.at, r.a), d); return [t - m.width / 2 - 100, t + m.width / 2 + 100]; });
    const cols = columnsOn(r).filter(t => t > -1 && t < L + 1);
    const ts = new Set();
    const ok = t => t > 99 && t < L - 99 && !holes.some(([h0, h1]) => t > h0 && t < h1) && !cols.some(c => Math.abs(c - t) < COLUMN / 2 + 40);
    for (const c of cols) for (const t of [c - A.endOffset, c + A.endOffset]) if (ok(t)) ts.add(round(t, 10));
    for (const t of [A.endOffset, L - A.endOffset]) if (ok(t)) ts.add(round(t, 10));
    let list = [...ts].sort((p, q) => p - q);
    for (let guard = 0; guard < 200; guard++) {
      let gap = null; const ends = [0, ...list, L];
      for (let i = 1; i < ends.length; i++) if (ends[i] - ends[i - 1] > A.maxSpacing + 0.5) { gap = [ends[i - 1], ends[i]]; break; }
      if (!gap) break;
      // prefer 455-lattice points near the middle of the gap
      const mid = (gap[0] + gap[1]) / 2, cands = [];
      for (let t = Math.ceil(gap[0] / (MODULE / 2)) * (MODULE / 2); t < gap[1]; t += MODULE / 2) if (ok(t) && t - gap[0] > 300 && gap[1] - t > 300) cands.push(t);
      const t = cands.sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid))[0] ?? (ok(mid) ? mid : null);
      if (t === null) { warnings.push(`anchor gap ${round(gap[1] - gap[0])} on riser ${segKey(r.a, r.b)} cannot be filled`); break; }
      list = [...list, round(t, 10)].sort((p, q) => p - q);
    }
    for (const t of list) anchors.push({ at: [r.a[0] + d[0] * t, r.a[1] + d[1] * t], riser: r, t });
  }
  // dedupe anchors at shared points
  const uniqAnchors = anchors.filter((a, i) => !anchors.slice(0, i).some(b2 => Math.hypot(a.at[0] - b2.at[0], a.at[1] - b2.at[1]) < 150));

  // 鋼製束 at the 910 grid inside void compartments, clear of risers / beams lines
  const posts = [], gx = model.spec.grid.x, gy = model.spec.grid.y, pitch = F.postPitch;
  const lines = risers;              // grade beams lie under the slab: posts stand on them (practice house A)
  for (let x = gx[0] + pitch; x < gx.at(-1) - 1; x += pitch) for (let y = gy[0] + pitch; y < gy.at(-1) - 1; y += pitch) {
    const p = [x, y];
    if (!pointInPolygon(p, model.poly)) continue;
    const c = compAt([x + 1, y + 1]);
    if (c < 0 || comps[c].doma) continue;
    if (lines.some(r => distToSeg(p, r.a, r.b) < F.postClear)) continue;
    posts.push(p);
  }
  return { risers, beams, doma, comps, manholes, anchors: uniqAnchors, posts, inspect, errors, warnings, compAt };
}
const dirOf = r => { const L = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]); return [(r.b[0] - r.a[0]) / L, (r.b[1] - r.a[1]) / L]; };
export function distToSeg(p, a, b) {
  const ab = sub(b, a), L2 = dot(ab, ab), t = L2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t);
}
function isDomaEdge(s, doma) { return doma.some(d => [[d.x1, d.y1, d.x2, d.y1], [d.x2, d.y1, d.x2, d.y2], [d.x1, d.y2, d.x2, d.y2], [d.x1, d.y1, d.x1, d.y2]].some(([x1, y1, x2, y2]) => {
  const mid = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]; return pointOnSegment(mid, [x1, y1], [x2, y2], 1); })); }
function pickInspection(model, voids, compAt) {
  // 床下点検口: in the wash room / storage if possible (office practice: 洗面所 or 収納), else the largest void
  const pref = model.rooms.filter(r => /洗面|脱衣|収納|CL|物入/u.test(r.name)).map(r => compAt(r.at)).find(c => c >= 0 && voids.some(v => v.id === c));
  return pref ?? voids.slice().sort((p, q) => q.area - p.area)[0]?.id ?? 0;
}

/** Section cut: line along the roof slope axis through the building, chosen off interior wall lines. */
export function sectionOf(model, b, roof) {
  const axis = b.section.axis ?? roof.axis;               // cut runs along this axis (shows the roof slope when = roof.axis)
  const across = axis === 'y' ? 'x' : 'y', g = across === 'x' ? model.spec.grid.x : model.spec.grid.y;
  const xs = model.poly.map(p => across === 'x' ? p[0] : p[1]), lo = Math.min(...xs), hi = Math.max(...xs);
  let at = b.section.at;
  if (at === null || at === undefined) {
    const cands = [];
    for (let i = 0; i + 1 < g.length; i++) cands.push((g[i] + g[i + 1]) / 2);
    const onWall = v => model.walls.some(w => w.kind === 'int' && (across === 'x' ? near(w.a[0], v, 100) && near(w.b[0], v, 100) : near(w.a[1], v, 100) && near(w.b[1], v, 100)));
    // prefer a cut that crosses many rooms and windows, near the middle
    const mid = (lo + hi) / 2;
    at = cands.filter(v => v > lo + 400 && v < hi - 400 && !onWall(v)).sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid))[0] ?? mid;
  }
  return { axis, across, at };
}

/** Normalise spec + building block and resolve everything. Throws E_SPEC on invalid input. */
export function buildBuilding(input) {
  const norm = normalizeSpec(input);
  if (norm.errors.length) throw Object.assign(new Error(`E_SPEC: ${norm.errors.join('; ')}`), { code: 'E_SPEC', details: norm.errors });
  const built = buildModel(norm.spec);
  if (built.errors.length) throw Object.assign(new Error(`E_SPEC: ${built.errors.join('; ')}`), { code: 'E_SPEC', details: built.errors });
  const b = merge(BUILDING_DEFAULTS, input.building ?? {});
  const errors = [], warnings = [];
  if (b.roof.type !== 'shed') errors.push(`roof.type ${b.roof.type}: only shed (片流れ) is implemented`);
  if (!['S', 'N', 'E', 'W'].includes(b.roof.low)) errors.push('roof.low must be S|N|E|W (low eave side)');
  if (!['riser', 'grade-beam'].includes(b.foundation.interior)) errors.push('foundation.interior must be riser|grade-beam');
  const model = built.model, levels = levelsOf(b);
  if (levels.ceiling > levels.beamBottom - 100) warnings.push(`ceiling ${levels.ceiling} leaves < 100 under the beam bottom ${levels.beamBottom}`);
  for (const o of model.openings) { const h = openingHeights(o, b); if (h.head > levels.beamBottom - levels.FL - 105) warnings.push(`opening ${o.id}: head FL+${h.head} reaches the lintel zone`); }
  if (errors.length) throw Object.assign(new Error(`E_SPEC: ${errors.join('; ')}`), { code: 'E_SPEC', details: errors });
  const roof = roofOf(b, model), facades = facadesOf(model, b), foundation = foundationOf(model, b), section = sectionOf(model, b, roof);
  warnings.push(...built.warnings, ...foundation.warnings);
  if (foundation.errors.length) throw Object.assign(new Error(`E_SPEC: ${foundation.errors.join('; ')}`), { code: 'E_SPEC', details: foundation.errors });
  return { spec: norm.spec, model, building: b, levels, roof, facades, foundation, section, warnings };
}
