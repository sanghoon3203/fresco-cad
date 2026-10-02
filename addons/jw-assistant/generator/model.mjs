// Resolve a normalised spec into plan geometry shared by the drawer and the evaluator.
import { COMPASS, onModule } from './spec.mjs';
import { itemFootprint, SYMBOLS } from './symbols.mjs';
import {
  sub, dot, unit, leftNormal, len, near, samePoint, offsetPolygon, pointInPolygon, pointOnSegment, polygonEdges,
  cellGrid, frameRect, frameToWorld, inRect, subtractIntervals, round
} from './geometry.mjs';

// Measured office wall assemblies (knowledge/office-drafting-rules.json wallAssemblies), negative = outside.
export const EXT = { out: -185, siding: -170, battenOut: -152, battenIn: -62, coreOut: -52.5, coreIn: 52.5, in: 65 };
export const INT = { half: 65, core: 52.5 };
export const COLUMN = 105;
export const JAMB = 65;            // column half (52.5) + jamb trim (12.5): rough opening = width - 2*JAMB
export const WINDOW_INNER_STEP = 16.5, WINDOW_STEP_V = -87;
export const MAX_COLUMN_GAP_EXT = 1820, MAX_COLUMN_GAP_INT = 2730;

const frameOf = (a, b) => { const t = unit(sub(b, a)); return { o: a, t, n: leftNormal(t), length: len(sub(b, a)) }; };
const axisOf = f => Math.abs(f.t[0]) > 0.5 ? 'x' : 'y';

/** Build geometry. Returns {model, errors[], warnings[]}. */
export function buildModel(spec) {
  const errors = [], warnings = [];
  const poly = spec.exterior;
  const outer = offsetPolygon(poly, EXT.out), inner = offsetPolygon(poly, EXT.in);
  const walls = [];
  polygonEdges(poly).forEach(([a, b], i) => walls.push({ id: `E${i + 1}`, kind: 'ext', a, b, frame: frameOf(a, b), vout: EXT.out, vin: EXT.in, junctions: [] }));
  for (const w of spec.walls) {
    let [a, b] = [w.from, w.to];
    if (a[0] > b[0] + 0.01 || a[1] > b[1] + 0.01) [a, b] = [b, a];
    if (!pointInPolygon([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], poly)) errors.push(`wall ${w.id}: lies outside the exterior polygon`);
    walls.push({ id: w.id, kind: 'int', a, b, frame: frameOf(a, b), vout: -INT.half, vin: INT.half, junctions: [], freeEnds: [] });
  }
  const ext = walls.filter(w => w.kind === 'ext'), ints = walls.filter(w => w.kind === 'int');
  const uOn = (w, p) => dot(sub(p, w.frame.o), w.frame.t);

  // Junctions: interior endpoints on other walls; crossings of perpendicular interior walls.
  for (const w of ints) for (const p of [w.a, w.b]) {
    const host = walls.find(h => h !== w && pointOnSegment(p, h.a, h.b, 1));
    if (host) { host.junctions.push(round(uOn(host, p), 10)); w.junctions.push(round(uOn(w, p), 10)); }
    else if (!pointInPolygon(p, poly)) errors.push(`wall ${w.id}: endpoint ${p} is outside the building`);
    else { w.freeEnds.push(p); w.junctions.push(round(uOn(w, p), 10)); }
  }
  for (let i = 0; i < ints.length; i++) for (let j = i + 1; j < ints.length; j++) {
    const A = ints[i], B = ints[j];
    if (axisOf(A.frame) === axisOf(B.frame)) {
      if (axisOf(A.frame) === 'x' ? near(A.a[1], B.a[1], 1) : near(A.a[0], B.a[0], 1)) {
        const [a0, a1] = axisOf(A.frame) === 'x' ? [A.a[0], A.b[0]] : [A.a[1], A.b[1]], [b0, b1] = axisOf(B.frame) === 'x' ? [B.a[0], B.b[0]] : [B.a[1], B.b[1]];
        if (Math.min(a1, b1) - Math.max(a0, b0) > 1) errors.push(`walls ${A.id} and ${B.id} overlap`);
      }
      continue;
    }
    const H = axisOf(A.frame) === 'x' ? A : B, V = H === A ? B : A, p = [V.a[0], H.a[1]];
    if (p[0] > H.a[0] + 1 && p[0] < H.b[0] - 1 && p[1] > V.a[1] + 1 && p[1] < V.b[1] - 1) { H.junctions.push(round(uOn(H, p), 10)); V.junctions.push(round(uOn(V, p), 10)); }
  }

  const gx0 = spec.grid.x[0] ?? 0, gy0 = spec.grid.y[0] ?? 0, onLattice = p => onModule(p[0], gx0) && onModule(p[1], gy0);
  for (const w of ints) for (const p of [w.a, w.b]) if (!onLattice(p)) errors.push(`wall ${w.id}: end ${p} is off the 455 module (尺モジュール)`);
  for (const w of walls) for (const u of w.junctions) { const p = frameToWorld(w.frame, u, 0); if (!onLattice(p)) errors.push(`wall ${w.id}: junction ${p.map(v => round(v, 10))} is off the 455 module`); }
  // Openings resolved onto walls.
  const openings = [];
  for (const o of spec.openings) {
    const cands = walls.filter(w => pointOnSegment(o.at, w.a, w.b, 1));
    const w = cands.find(c => c.kind === 'ext') ?? cands[0];
    if (!w) { errors.push(`opening ${o.id}: at ${o.at} is not on any wall centreline`); continue; }
    if ((o.type === 'window-sliding' || o.type === 'entrance-door') && w.kind !== 'ext') { errors.push(`opening ${o.id}: ${o.type} must be on an exterior wall`); continue; }
    const f = w.frame, u = uOn(w, o.at), half = o.width / 2;
    if (u - half < -0.5 || u + half > f.length + 0.5) { errors.push(`opening ${o.id}: jamb columns run past the wall ends (u ${round(u)} ± ${half} on ${w.id} length ${round(f.length)})`); continue; }
    const hit = w.junctions.find(j => j > u - half + 1 && j < u + half - 1);
    if (hit !== undefined) { errors.push(`opening ${o.id}: crosses a wall junction on ${w.id}`); continue; }
    let s = 0;
    if (o.swing) { s = Math.sign(dot(COMPASS[o.swing], f.n)); if (!s) { errors.push(`opening ${o.id}: swing ${o.swing} is parallel to the wall`); continue; } }
    else if (o.type === 'entrance-door') s = -1;
    else if (o.type === 'door-sliding' || o.type === 'door-sliding-double') s = 1;
    const lowerFirst = f.t[0] + f.t[1] > 0;         // u grows with world x/y?
    const hingeAtR0 = (o.hinge === 'start') === lowerFirst, slideToR0 = (o.slide === 'start') === lowerFirst;
    const r0 = u - half + JAMB, r1 = u + half - JAMB;
    const jambsW = [frameToWorld(f, u - half, 0), frameToWorld(f, u + half, 0)];
    if (!jambsW.every(onLattice)) warnings.push(`opening ${o.id}: jamb columns ${jambsW.map(p => p.map(v => round(v, 10)).join(',')).join(' / ')} off the 455 module (allowed for openings; shown in the opening-position dimension tier)`);
    openings.push({ ...o, wall: w.id, wallKind: w.kind, frame: f, u, r0, r1, vout: w.vout, vin: w.vin, swingSign: s, hingeAtR0, slideToR0,
      jambs: [frameToWorld(f, u - half, 0), frameToWorld(f, u + half, 0)], clear: r1 - r0,
      leaf: o.type === 'entrance-door' ? Math.min(r1 - r0 - 48, 910) : r1 - r0 - 48 });   // entrance: ~900 leaf, rest is a fixed side panel (袖FIX)
  }
  for (const w of walls) {
    const own = openings.filter(o => o.wall === w.id).sort((a, b) => a.u - b.u);
    for (let i = 1; i < own.length; i++) if (own[i].u - own[i].width / 2 < own[i - 1].u + own[i - 1].width / 2 - 0.5) errors.push(`openings ${own[i - 1].id} and ${own[i].id} overlap on ${w.id}`);
  }

  // Columns (柱1 105 square).
  const columns = [];
  const addColumn = (p, why) => { if (!columns.some(c => samePoint(c.at, p, 60))) columns.push({ at: [round(p[0], 10), round(p[1], 10)], why }); };
  for (const p of poly) addColumn(p, 'corner');
  for (const w of ints) {
    for (const p of [w.a, w.b]) addColumn(p, w.freeEnds.some(q => samePoint(q, p)) ? 'wall-end' : 'junction');
    for (const u of w.junctions) addColumn(frameToWorld(w.frame, u, 0), 'junction');
  }
  for (const o of openings) for (const p of o.jambs) addColumn(p, 'jamb');
  if (spec.options.columns !== false) for (const w of walls) {
    const max = w.kind === 'ext' ? MAX_COLUMN_GAP_EXT : MAX_COLUMN_GAP_INT, f = w.frame, ax = axisOf(f);
    const gridVals = ax === 'x' ? spec.grid.x : spec.grid.y, blocked = openings.filter(o => o.wall === w.id).map(o => [o.u - o.width / 2 - 60, o.u + o.width / 2 + 60]);
    for (let guard = 0; guard < 50; guard++) {
      const us = columns.map(c => c.at).filter(p => pointOnSegment(p, w.a, w.b, 1)).map(p => uOn(w, p)).sort((a, b) => a - b);
      let gap = null;
      for (let i = 1; i < us.length; i++) if (us[i] - us[i - 1] > max + 0.5) { gap = [us[i - 1], us[i]]; break; }
      if (!gap) break;
      const origin = ax === 'x' ? f.o[0] : f.o[1], sign = ax === 'x' ? f.t[0] : f.t[1];
      const toU = g => (g - origin) * sign, mid = (gap[0] + gap[1]) / 2;
      const half = [...new Set([...gridVals, ...gridVals.slice(0, -1).map((g, i) => (g + gridVals[i + 1]) / 2)])].map(toU);
      const cand = half.filter(u => u > gap[0] + 300 && u < gap[1] - 300 && !blocked.some(([b0, b1]) => u > b0 && u < b1)).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
      if (cand === undefined) { warnings.push(`wall ${w.id}: column gap ${round(gap[1] - gap[0])} mm > ${max} with no free grid position`); break; }
      addColumn(frameToWorld(f, cand, 0), 'spacing');
    }
  }

  // Wall bodies: union of the exterior band and interior wall rectangles, openings cut (for face lines) or not (for rooms).
  const intRects = ints.map(w => frameRect(w.frame, -INT.half, w.frame.length + INT.half, -INT.half, INT.half));
  const cuts = [], dropBoxes = [];
  for (const o of openings) {
    const f = o.frame;
    if (o.type === 'window-sliding') {
      cuts.push(frameRect(f, o.r0, o.r1, o.vout - 1, WINDOW_STEP_V));
      cuts.push(frameRect(f, o.r0 + WINDOW_INNER_STEP, o.r1 - WINDOW_INNER_STEP, WINDOW_STEP_V, o.vin + 1));
    } else cuts.push(frameRect(f, o.r0, o.r1, o.vout - 1, o.vin + 1));
    dropBoxes.push(frameRect(f, o.r0 - 0.01, o.r1 + 0.01, o.vout + 0.01, o.vin - 0.01));
  }
  const xs = [...outer.map(p => p[0]), ...inner.map(p => p[0])], ys = [...outer.map(p => p[1]), ...inner.map(p => p[1])];
  for (const r of [...intRects, ...cuts]) { xs.push(r.x1, r.x2); ys.push(r.y1, r.y2); }
  const inBand = (x, y) => pointInPolygon([x, y], outer) && !pointInPolygon([x, y], inner);
  const solid = (x, y) => inBand(x, y) || intRects.some(r => inRect(r, [x, y]));
  const bodies = cellGrid(xs, ys, (x, y) => solid(x, y) && !cuts.some(r => inRect(r, [x, y])));
  const bodiesSolid = cellGrid(xs, ys, solid);

  // Rooms on wall centrelines (壁芯面積, as the office labels areas).
  const segs = walls.map(w => [w.a, w.b]);
  const rxs = [...poly.map(p => p[0]), ...ints.flatMap(w => [w.a[0], w.b[0]])], rys = [...poly.map(p => p[1]), ...ints.flatMap(w => [w.a[1], w.b[1]])];
  for (const r of spec.rooms) if (r.rect) { rxs.push(r.rect[0], r.rect[2]); rys.push(r.rect[1], r.rect[3]); }
  const roomGrid = cellGrid(rxs, rys, (x, y) => pointInPolygon([x, y], poly));
  const blockedV = (x, y0, y1) => segs.some(([a, b]) => near(a[0], x, 0.5) && near(b[0], x, 0.5) && Math.min(a[1], b[1]) <= y0 + 0.5 && Math.max(a[1], b[1]) >= y1 - 0.5);
  const blockedH = (y, x0, x1) => segs.some(([a, b]) => near(a[1], y, 0.5) && near(b[1], y, 0.5) && Math.min(a[0], b[0]) <= x0 + 0.5 && Math.max(a[0], b[0]) >= x1 - 0.5);
  const flood = start => {
    const { nx, ny, xs: gx, ys: gy } = roomGrid, seen = new Uint8Array(nx * ny), out = [];
    if (start[0] < 0 || start[1] < 0 || !roomGrid.at(...start)) return out;
    const stack = [start]; seen[start[1] * nx + start[0]] = 1;
    while (stack.length) {
      const [i, j] = stack.pop(); out.push([i, j]);
      const nb = [[i + 1, j, !blockedV(gx[i + 1], gy[j], gy[j + 1])], [i - 1, j, !blockedV(gx[i], gy[j], gy[j + 1])],
        [i, j + 1, !blockedH(gy[j + 1], gx[i], gx[i + 1])], [i, j - 1, !blockedH(gy[j], gx[i], gx[i + 1])]];
      for (const [a, b, open] of nb) if (open && a >= 0 && b >= 0 && a < nx && b < ny && roomGrid.at(a, b) && !seen[b * nx + a]) { seen[b * nx + a] = 1; stack.push([a, b]); }
    }
    return out;
  };
  const regionKey = cells => cells.map(c => c.join(',')).sort()[0];
  const rooms = spec.rooms.map(r => {
    let cells = flood(roomGrid.cellOf(r.at));
    if (!cells.length) errors.push(`room ${r.name}: label point ${r.at} is outside the building`);
    if (r.rect) { const [x1, y1, x2, y2] = r.rect; cells = cells.filter(([i, j]) => { const cx = (roomGrid.xs[i] + roomGrid.xs[i + 1]) / 2, cy = (roomGrid.ys[j] + roomGrid.ys[j + 1]) / 2; return cx > Math.min(x1, x2) && cx < Math.max(x1, x2) && cy > Math.min(y1, y2) && cy < Math.max(y1, y2); }); }
    const area = cells.reduce((s, [i, j]) => s + (roomGrid.xs[i + 1] - roomGrid.xs[i]) * (roomGrid.ys[j + 1] - roomGrid.ys[j]), 0);
    const bx = cells.flatMap(([i]) => [roomGrid.xs[i], roomGrid.xs[i + 1]]), by = cells.flatMap(([, j]) => [roomGrid.ys[j], roomGrid.ys[j + 1]]);
    return { ...r, cells, region: cells.length ? regionKey(flood(cells[0])) : null, area, areaM2: Math.round(area / 1e4) / 100, jo: Math.round(area / 1e6 / 1.62 * 10) / 10,
      bbox: cells.length ? { x1: Math.min(...bx), y1: Math.min(...by), x2: Math.max(...bx), y2: Math.max(...by) } : null,
      contains: p => { const [i, j] = roomGrid.cellOf(p); return cells.some(c => c[0] === i && c[1] === j); } };
  });
  const byRegion = new Map();
  for (const r of rooms) if (r.region && !r.rect) { if (byRegion.has(r.region)) warnings.push(`rooms ${byRegion.get(r.region)} and ${r.name} share one enclosed region (give one a rect)`); else byRegion.set(r.region, r.name); }

  // Clear (finish-face) widths per room from the solid wall bodies.
  for (const r of rooms) r.clear = clearExtent(bodiesSolid, r.at, inner);

  const items = spec.items.map(it => ({ ...it, ...itemFootprint(it.at, it.rotation, it.size, SYMBOLS[it.type].pad) }));
  return { model: { spec, poly, outer, inner, walls, openings, columns, bodies, bodiesSolid, intRects, dropBoxes, roomGrid, rooms, items }, errors, warnings };
}

/** Free (finish-face) region around p: bbox and minimum clear width (min over cells of the shorter free run). */
export function clearExtent(grid, p, innerPoly) {
  const { nx, ny, xs, ys } = grid, start = grid.cellOf(p);
  const free = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && !grid.at(i, j) && pointInPolygon([(xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2], innerPoly);
  if (!free(...start)) return null;
  const seen = new Uint8Array(nx * ny), cells = [], stack = [start]; seen[start[1] * nx + start[0]] = 1;
  while (stack.length) {
    const [i, j] = stack.pop(); cells.push([i, j]);
    for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) if (free(a, b) && !seen[b * nx + a]) { seen[b * nx + a] = 1; stack.push([a, b]); }
  }
  const inSet = new Set(cells.map(c => c.join(',')));
  let minWidth = Infinity;
  for (const [i, j] of cells) {
    let a = i, b = i; while (inSet.has(`${a - 1},${j}`)) a--; while (inSet.has(`${b + 1},${j}`)) b++;
    let c = j, d = j; while (inSet.has(`${i},${c - 1}`)) c--; while (inSet.has(`${i},${d + 1}`)) d++;
    minWidth = Math.min(minWidth, Math.min(xs[b + 1] - xs[a], ys[d + 1] - ys[c]));
  }
  const bx = cells.flatMap(([i]) => [xs[i], xs[i + 1]]), by = cells.flatMap(([, j]) => [ys[j], ys[j + 1]]);
  return { bbox: { x1: Math.min(...bx), y1: Math.min(...by), x2: Math.max(...bx), y2: Math.max(...by) }, minWidth: round(minWidth, 10), cells: cells.length };
}

/** Intervals along a wall (u) occupied by columns and openings, for breaking core lines / insulation. */
export function wallCuts(model, w, { openingPad = 12.5 } = {}) {
  const cuts = [];
  for (const c of model.columns) if (pointOnSegment(c.at, w.a, w.b, 1)) { const u = dot(sub(c.at, w.frame.o), w.frame.t); cuts.push([u - COLUMN / 2, u + COLUMN / 2]); }
  for (const o of model.openings) if (o.wall === w.id) cuts.push([o.r0 - openingPad, o.r1 + openingPad]);
  return cuts;
}
export { subtractIntervals };
