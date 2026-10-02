// drawFoundationPlan(spec)  -> 基礎伏図 1/50 (A3): risers from the exterior walls + interior foundation lines,
//   人通口, anchor bolts, 鋼製束 at the 910 grid, slab marks, dimensions and grid bubbles.
// drawFoundationDetails(spec) -> 基礎詳細図 1/25 (A3): perimeter section FG1, interior riser (or grade beam) section,
//   人通口 elevation and the standard notes.
// Derived from buildBuilding(spec); conventions measured from practice house A
// (knowledge/office-drafting-rules-foundation.json).
import { buildBuilding } from './building.mjs';
import { Sheet, styleTable, newSheetDocument, emit, drawFrame, finish, fmt, PAPER } from './sheet.mjs';
import { offsetPolygon, polygonEdges, pointInPolygon, cellGrid, gridBoundary, inRect, clipLineToRings, subtractIntervals } from './geometry.mjs';
import { onModule } from './spec.mjs';

export const SCALE = 50, DETAIL_SCALE = 25;
export const PEN = {
  aux: { color: 4, style: 5 }, riser: { color: 2, style: 1 }, eps: { color: 7, style: 1 }, mortar: { color: 1, style: 1 }, footing: { color: 3, style: 3 },
  beam: { color: 1, style: 4 }, beamHatch: { color: 7, style: 1 }, post: { color: 6, style: 1 }, anchor: { color: 2, style: 1 }, anchorX: { color: 1, style: 1 },
  slab: { color: 4, style: 1 }, inspect: { color: 2, style: 2 }, text: { color: 1, style: 1 }, dim: { color: 1, style: 1 }, dimExt: { color: 4, style: 5 },
  gridStub: { color: 7, style: 5 }, bubble: { color: 1, style: 1 }, manhole: { color: 1, style: 2 }
};
export const LAYER = { aux: '1:0', riser: '1:1', beam: '1:2', post: '1:3', anchor: '1:4', manhole: '1:5', slab: '1:6', inspect: '1:7', hatch: '1:8', grid: '1:A', fill: '1:B', text: '1:D', dim: '1:E' };
export const TEXT = { note: 3, dim: 3, title: 4 };
export const GRID_TEXT = { h: 3.5, w: 3.5, sp: -0.2 };
export const MEASURED = { epsFace: 175, mortarFace: 200, footingInner: 200, postR: 50, postArm: 100, slabLabel: ['耐圧版180t', '-400'], dimFirst: 1000, dimPitch: 250, bubbleR: 150 };

const RGB = { riser: 0xe0e0e0, eps: 0xffe0e0, black: 0x000000, white: 0xffffff };

function riserBodies(B) {
  const { model, foundation: FD, building: b } = B, F = b.foundation, half = F.riser / 2;
  const outer = offsetPolygon(model.poly, -half), inner = offsetPolygon(model.poly, half);
  const rects = FD.risers.filter(r => r.kind === 'int').map(r => {
    const xs = [r.a[0], r.b[0]], ys = [r.a[1], r.b[1]];
    return { x1: Math.min(...xs) - half, y1: Math.min(...ys) - half, x2: Math.max(...xs) + half, y2: Math.max(...ys) + half };
  });
  const holes = FD.manholes.map(m => {
    const d = m.dir, w = m.width / 2, n = [-d[1], d[0]], p0 = [m.at[0] - d[0] * w - n[0] * (half + 1), m.at[1] - d[1] * w - n[1] * (half + 1)], p1 = [m.at[0] + d[0] * w + n[0] * (half + 1), m.at[1] + d[1] * w + n[1] * (half + 1)];
    return { x1: Math.min(p0[0], p1[0]), y1: Math.min(p0[1], p1[1]), x2: Math.max(p0[0], p1[0]), y2: Math.max(p0[1], p1[1]) };
  });
  const xs = [...outer.map(p => p[0]), ...inner.map(p => p[0]), ...rects.flatMap(r => [r.x1, r.x2]), ...holes.flatMap(r => [r.x1, r.x2])];
  const ys = [...outer.map(p => p[1]), ...inner.map(p => p[1]), ...rects.flatMap(r => [r.y1, r.y2]), ...holes.flatMap(r => [r.y1, r.y2])];
  const solid = (x, y) => (pointInPolygon([x, y], outer) && !pointInPolygon([x, y], inner)) || rects.some(r => inRect(r, [x, y]));
  return { grid: cellGrid(xs, ys, (x, y) => solid(x, y) && !holes.some(h => inRect(h, [x, y]))), outer, inner, rects, holes };
}

/** Foundation plan sheet. */
export function drawFoundationPlan(input, { building: prebuilt } = {}) {
  const B = prebuilt ?? buildBuilding(input), { model, foundation: FD, building: b } = B, F = b.foundation, warnings = [];
  const S = new Sheet(SCALE, styleTable('foundation')), info = { risers: FD.risers.length, beams: FD.beams.length, manholes: [], anchors: FD.anchors.length, posts: FD.posts.length, labels: [] };
  const poly = model.poly, xs = poly.map(p => p[0]), ys = poly.map(p => p[1]), [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // 1:0 grid lines (910 + 455 lines used by foundation lines), clipped to the footprint
  const g = model.spec.grid, ring = offsetPolygon(poly, -1);
  const usedX = new Set(FD.risers.concat(FD.beams).flatMap(r => [r.a[0], r.b[0]])), usedY = new Set(FD.risers.concat(FD.beams).flatMap(r => [r.a[1], r.b[1]]));
  const half = v => v.slice(0, -1).map((a, i) => (a + v[i + 1]) / 2);
  for (const x of [...g.x, ...half(g.x).filter(v => usedX.has(v))]) for (const [t0, t1] of clipLineToRings([x, y0 - 10], [0, 1], [ring])) S.line(LAYER.aux, PEN.aux, [x, Math.max(y0, y0 - 10 + t0)], [x, Math.min(y1, y0 - 10 + t1)]);
  for (const y of [...g.y, ...half(g.y).filter(v => usedY.has(v))]) for (const [t0, t1] of clipLineToRings([x0 - 10, y], [1, 0], [ring])) S.line(LAYER.aux, PEN.aux, [Math.max(x0, x0 - 10 + t0), y], [Math.min(x1, x0 - 10 + t1), y]);
  // risers: union boundary (clean corners / T junctions), cut at 人通口; fills
  const RB = riserBodies(B);
  for (const [a, c] of gridBoundary(RB.grid)) S.line(LAYER.riser, PEN.riser, a, c);
  for (let j = 0; j < RB.grid.ny; j++) for (let i = 0; i < RB.grid.nx; i++) if (RB.grid.at(i, j)) {
    const [a, c, d, e] = [RB.grid.xs[i], RB.grid.xs[i + 1], RB.grid.ys[j], RB.grid.ys[j + 1]];
    S.solid(LAYER.fill, [[a, d], [c, d], [c, e], [a, e]], RGB.riser);
  }
  const eps = offsetPolygon(poly, -MEASURED.epsFace), mortar = offsetPolygon(poly, -MEASURED.mortarFace), foot = offsetPolygon(poly, MEASURED.footingInner);
  S.poly(LAYER.riser, PEN.eps, eps, true); S.poly(LAYER.riser, PEN.mortar, mortar, true); S.poly(LAYER.riser, PEN.footing, foot, true);
  // EPS band fill (pink) as quads per edge
  polygonEdges(RB.outer).forEach(([a, c], i) => { const e = polygonEdges(eps)[i]; S.solid(LAYER.fill, [a, c, e[1], e[0]], RGB.eps); });
  // grade beams (地中梁): dashed faces ±300 + 45° hatch
  for (const r of FD.beams) {
    const hz = Math.abs(r.a[1] - r.b[1]) < 1, w = F.gradeBeamWidth / 2;
    const R = hz ? { x1: Math.min(r.a[0], r.b[0]) + F.riser / 2, x2: Math.max(r.a[0], r.b[0]) - F.riser / 2, y1: r.a[1] - w, y2: r.a[1] + w } : { x1: r.a[0] - w, x2: r.a[0] + w, y1: Math.min(r.a[1], r.b[1]) + F.riser / 2, y2: Math.max(r.a[1], r.b[1]) - F.riser / 2 };
    if (hz) { S.line(LAYER.beam, PEN.beam, [R.x1, R.y1], [R.x2, R.y1]); S.line(LAYER.beam, PEN.beam, [R.x1, R.y2], [R.x2, R.y2]); }
    else { S.line(LAYER.beam, PEN.beam, [R.x1, R.y1], [R.x1, R.y2]); S.line(LAYER.beam, PEN.beam, [R.x2, R.y1], [R.x2, R.y2]); }
    const rg = [[R.x1, R.y1], [R.x2, R.y1], [R.x2, R.y2], [R.x1, R.y2]];
    for (let c = R.x1 - R.y2; c < R.x2 - R.y1; c += 100) for (const [t0, t1] of clipLineToRings([c, 0], [Math.SQRT1_2, Math.SQRT1_2], [rg])) S.line(LAYER.hatch, PEN.beamHatch, [c + t0 * Math.SQRT1_2, t0 * Math.SQRT1_2], [c + t1 * Math.SQRT1_2, t1 * Math.SQRT1_2]);
  }
  // slab compartments: triple diagonal marks + "耐圧版180t / -400" labels; doma label
  for (const c of FD.comps) {
    if (c.area < 1.5e6) continue;
    const [cx, cy] = c.center;
    if (c.doma) { S.atext(LAYER.text, [cx, cy + 120], '土間コンクリート', TEXT.note, { ax: 0.5, ay: 0 }); S.atext(LAYER.text, [cx, cy - 120], `${F.domaSlab}t`, TEXT.note, { ax: 0.5, ay: 1 }); info.labels.push('土間'); continue; }
    const at = [cx, cy];
    if (FD.compAt(at) !== c.id) continue;
    S.atext(LAYER.text, [cx, cy + 60], MEASURED.slabLabel[0].replace('180', String(F.slab)), TEXT.note, { ax: 0.5, ay: 0 });
    S.atext(LAYER.text, [cx, cy - 60], `-${b.levels.foundationTop - F.slabTop}`, TEXT.note, { ax: 0.5, ay: 1 });
    for (const k of [-1, 0, 1]) S.line(LAYER.slab, PEN.slab, [cx - 600 + k * 50, cy - 900 - k * 50], [cx - 100 + k * 50, cy - 400 - k * 50]);
    info.labels.push('耐圧版');
  }
  // 鋼製束 (posts) at 910 grid
  for (const p of FD.posts) {
    S.arc(LAYER.post, PEN.post, p, MEASURED.postR);
    S.line(LAYER.post, PEN.post, [p[0] - MEASURED.postArm, p[1]], [p[0] + MEASURED.postArm, p[1]]); S.line(LAYER.post, PEN.post, [p[0], p[1] - MEASURED.postArm], [p[0], p[1] + MEASURED.postArm]);
  }
  // anchor bolts on the riser centreline
  for (const a of FD.anchors) { S.arc(LAYER.anchor, PEN.anchor, a.at, 45); S.solid(LAYER.anchor, [[a.at[0] - 18, a.at[1] - 18], [a.at[0] + 18, a.at[1] - 18], [a.at[0] + 18, a.at[1] + 18], [a.at[0] - 18, a.at[1] + 18]], RGB.black); }
  // 人通口: dashed closing lines across the opening + label
  for (const m of FD.manholes) {
    const d = m.dir, n = [-d[1], d[0]], w = m.width / 2, h = F.riser / 2;
    for (const s of [-1, 1]) S.line(LAYER.manhole, PEN.manhole, [m.at[0] - d[0] * w + n[0] * h * s, m.at[1] - d[1] * w + n[1] * h * s], [m.at[0] + d[0] * w + n[0] * h * s, m.at[1] + d[1] * w + n[1] * h * s]);
    const lp = [m.at[0] + n[0] * 380 + d[0] * 0, m.at[1] + n[1] * 380];
    S.atext(LAYER.text, lp, `人通口 W${m.width}`, 0, { ax: 0.5, ay: 0.5, size: { h: 2.5, w: 2.5 }, angle: Math.abs(d[0]) > 0.5 ? 0 : 90 });
    info.manholes.push({ at: m.at, why: m.why });
  }
  // 床下点検口 600x450 in the inspection compartment
  const ic = FD.comps.find(c => c.id === FD.inspect);
  if (ic) { const [cx, cy] = ic.center; S.rect(LAYER.inspect, PEN.inspect, cx + 300, cy + 300, cx + 900, cy + 750); S.atext(LAYER.text, [cx + 600, cy + 860], '床下点検口', 0, { ax: 0.5, ay: 0, size: { h: 2.5, w: 2.5 } }); info.inspection = [cx + 600, cy + 525]; }
  // dimensions: riser-line tier + overall, both on all four sides; grid bubbles beyond
  const base = {};
  const lines = FD.risers.concat(FD.beams);
  for (const side of ['S', 'E', 'N', 'W']) {
    const horiz = side === 'S' || side === 'N', sgn = side === 'S' || side === 'W' ? -1 : 1, ext = { S: y0, N: y1, W: x0, E: x1 }[side];
    const coord = p => horiz ? p[0] : p[1], P = (u, v) => horiz ? [u, v] : [v, u];
    const perp = lines.filter(r => horiz ? Math.abs(r.a[0] - r.b[0]) < 1 : Math.abs(r.a[1] - r.b[1]) < 1);
    const facing = perp.filter(r => (horiz ? [r.a[1], r.b[1]] : [r.a[0], r.b[0]]).some(v => Math.abs(v - ext) < 1));
    const struct = [...new Set([...poly.map(coord), ...facing.map(r => coord(r.a))].map(v => Math.round(v * 10) / 10))].sort((p, q) => p - q);
    const all = [...new Set([...struct, ...perp.map(r => coord(r.a))].map(v => Math.round(v * 10) / 10))].sort((p, q) => p - q);
    const tiers = [all, [struct[0], struct.at(-1)]].filter((t, i, arr) => t.length >= 2 && arr.findIndex(x => x.join() === t.join()) === i);
    tiers.forEach((vals, k) => {
      const v = ext + sgn * (MEASURED.dimFirst + k * MEASURED.dimPitch);
      S.line(LAYER.dim, PEN.dim, P(vals[0], v), P(vals.at(-1), v));
      for (const u of vals) S.point(LAYER.dim, P(u, v));
      for (let i = 1; i < vals.length; i++) S.atext(LAYER.dim, P((vals[i] + vals[i - 1]) / 2, v + 40), fmt(vals[i] - vals[i - 1]), TEXT.dim, horiz ? { ax: 0.5, ay: 0 } : { angle: 90, ax: 0.5, ay: 1 });
    });
    for (const u of tiers[0]) S.line(LAYER.dim, PEN.dimExt, P(u, ext + sgn * (MEASURED.dimFirst + (tiers.length - 1) * MEASURED.dimPitch)), P(u, ext + sgn * 300));
    base[side] = ext + sgn * (MEASURED.dimFirst + (tiers.length - 1) * MEASURED.dimPitch);
    info[`dims${side}`] = tiers;
  }
  for (const side of ['S', 'N', 'W', 'E']) {
    const horiz = side === 'S' || side === 'N', sgn = side === 'S' || side === 'W' ? -1 : 1, vals = horiz ? g.x : g.y, labs = horiz ? g.xLabels : g.yLabels, P = (u, v) => horiz ? [u, v] : [v, u];
    vals.forEach((u, i) => { const v0 = base[side], vc = v0 + sgn * 500; S.line(LAYER.grid, PEN.gridStub, P(u, v0), P(u, v0 + sgn * 350)); S.arc(LAYER.grid, PEN.bubble, P(u, vc), MEASURED.bubbleR); S.atext(LAYER.grid, P(u, vc), labs[i], 0, { ax: 0.5, ay: 0.5, size: { ...GRID_TEXT, w: Math.min(3.5, 4.6 / Math.max(1, [...labs[i]].length / 2)) } }); });
  }
  // legend + notes (bottom-left of the drawing) and title
  const lx = x0 - 2400, ly = y0 + 300;   // legend left of the W bubbles (right-aligned), bottom up
  const legend = [
    [p => { S.arc(LAYER.text, PEN.post, p, MEASURED.postR); S.line(LAYER.text, PEN.post, [p[0] - 100, p[1]], [p[0] + 100, p[1]]); S.line(LAYER.text, PEN.post, [p[0], p[1] - 100], [p[0], p[1] + 100]); }, `鋼製束 @${F.postPitch}`],
    [p => { S.arc(LAYER.text, PEN.anchor, p, 45); S.solid(LAYER.text, [[p[0] - 18, p[1] - 18], [p[0] + 18, p[1] - 18], [p[0] + 18, p[1] + 18], [p[0] - 18, p[1] + 18]], RGB.black); }, `アンカーボルト ${F.anchor.size} L=${F.anchor.length}`],
    [null, `基礎天端 = ±0 (設計GL+${b.levels.foundationTop})`], [null, `基礎断熱 EPS ${F.edgeInsulation}t 打込み`],
    [null, F.interior === 'grade-beam' ? `地中梁 W${F.gradeBeamWidth} (点線)` : `人通口 W${F.manholeWidth}`]
  ];
  legend.forEach(([sym, t], i) => { const y = ly + (legend.length - 1 - i) * 320, tw = S.textLen(t, TEXT.note) * SCALE; if (sym) sym([lx - tw - 200, y]); S.atext(LAYER.text, [lx, y], t, TEXT.note, { ax: 1, ay: 0.5 }); });
  info.legend = legend.map(l => l[1]);
  // layout
  let bb = S.bbox();
  const [ax1, ay1, ax2, ay2] = PAPER.area, w = (bb[2] - bb[0]) / SCALE, h = (bb[3] - bb[1]) / SCALE;
  if (w > ax2 - ax1 || h > ay2 - ay1) warnings.push(`foundation plan ${Math.round(w)}x${Math.round(h)} mm exceeds the A3 drawing area at 1/${SCALE}`);
  const titleAt = [(x0 + x1) / 2, bb[1] - 500], tb = S.atext(LAYER.text, titleAt, `基礎伏図 1/${SCALE}`, TEXT.title, { ax: 0.5, ay: 0.5 });
  S.rect(LAYER.text, PEN.text, tb.x1 - 100, tb.y1 - 80, tb.x2 + 100, tb.y2 + 80);
  bb = S.bbox();
  const d = [Math.round(((ax1 + ax2) / 2 * SCALE - (bb[0] + bb[2]) / 2) / 10) * 10, Math.round(((ay1 + ay2) / 2 * SCALE - (bb[1] + bb[3]) / 2) / 10) * 10];
  S.translate(d);
  const doc = newSheetDocument('foundation', { 1: { name: '基礎伏図', scale: SCALE } }, `fresco set-generator foundation scale=${SCALE} origin=${-d[0]},${-d[1]}`);
  emit(doc, S);
  emit(doc, drawFrame(styleTable('foundation'), { ...B.spec.title, drawing: '基礎伏図', scale: `1/${SCALE}`, sheet: 'S-01' }));
  return { bytes: finish(doc), doc, info, layout: { offset: d, bbox: S.bbox() }, warnings: [...B.warnings, ...warnings], building: B };
}

// ---------------- details ----------------
/** One foundation cross-section at 1/25 in local coordinates (x across, y above GL), centre of the riser at x=0. */
function foundationSection(S, b, kind) {
  const F = b.foundation, L = b.levels, top = L.foundationTop, r = F.riser / 2, ft = -F.footingBottom + F.footingThickness, fb = -F.footingBottom, gb = fb - F.gravel;
  const slabT = F.slabTop, slabB = slabT - F.slab, epsB = slabB - F.slabInsulation, grvB = epsB - F.slabGravel;
  const P = { c: { color: 2, style: 1 }, t: { color: 1, style: 1 }, h: { color: 5, style: 1 }, g: { color: 1, style: 1 }, bar: { color: 3, style: 1 }, gl: { color: 1, style: 5 } };
  const L1 = '1:1', LH = '1:6', LG = '1:4', LB = '1:5', LR = '1:2', LF = '1:B';
  const out = { kind, dims: {} };
  const hatchV = (x0, x1, y0, y1, pitch = 12) => { for (let x = Math.min(x0, x1) + pitch / 2; x < Math.max(x0, x1); x += pitch) S.line(LH, P.h, [x, y0], [x, y1]); };
  const hatchH = (x0, x1, y0, y1, pitch = 12) => { for (let y = Math.min(y0, y1) + pitch / 2; y < Math.max(y0, y1); y += pitch) S.line(LH, P.h, [x0, y], [x1, y]); };
  const gravel = (x0, x1, y0, y1) => { S.rect(L1, P.c, x0, y0, x1, y1); for (let x = x0 + 30; x < x1 - 30; x += 60) S.poly(LG, P.g, [[x, y0 + 15], [x + 20, y1 - 15], [x + 40, y0 + 15]]); };
  const bar = (x, y) => { S.arc(LR, P.c, [x, y], 6.5); S.solid(LR, [[x - 4, y - 4], [x + 4, y - 4], [x + 4, y + 4], [x - 4, y + 4]], 0x000000); };
  if (kind === 'perimeter' || kind === 'interior') {
    const outer = kind === 'perimeter';
    gravel(-F.gravelWidth / 2, F.gravelWidth / 2, gb, fb);
    S.rect(L1, P.c, -F.footingWidth / 2, fb, F.footingWidth / 2, ft);
    S.solid(LF, [[-r, ft], [r, ft], [r, top], [-r, top]], 0xe6e6e6);
    S.line(L1, P.c, [-r, ft], [-r, top]); S.line(L1, P.c, [r, ft], [r, top]); S.line(L1, P.c, [-r, top], [r, top]);
    // slab on the inner side (right), and on both sides for an interior riser
    for (const s of outer ? [1] : [-1, 1]) {
      const x0 = s * (r + (outer ? F.innerInsulation : 0)), x1 = s * 1200;
      S.line(L1, P.c, [s * r, slabT], [x1, slabT]); S.line(L1, P.c, [x0, slabB], [x1, slabB]); S.line(L1, P.c, [x0, epsB], [x1, epsB]);
      hatchV(x0, x1, epsB, slabB, 14);
      gravel(Math.min(x0, x1) + (s > 0 ? 0 : 0), Math.max(x0, x1), grvB, epsB);
      S.line(L1, P.t, [x1, grvB - 80], [x1, slabT + 80]);                       // break line
      // slab bars D13@200 (two layers)
      for (let x = x0 + s * 150; Math.abs(x) < 1150; x += s * 200) { bar(x, slabT - 50); bar(x, slabB + 50); }
    }
    if (outer) {
      // outer EPS 100 + mortar, inner EPS 50 down to the footing
      S.rect(L1, P.c, -r - F.edgeInsulation, ft, -r, top); hatchH(-r - F.edgeInsulation, -r, ft, top, 14);
      S.line(L1, P.t, [-r - F.edgeInsulation - F.mortar, -180], [-r - F.edgeInsulation - F.mortar, top]);
      S.rect(L1, P.c, r, ft, r + F.innerInsulation, slabB); hatchH(r, r + F.innerInsulation, ft, slabB, 14);
      const sx = -r - F.edgeInsulation, sk = F.skirt;
      S.poly(L1, P.c, [[sx, -230], [sx - sk[0], -230 - sk[0] * 0.05], [sx - sk[0], -230 - sk[0] * 0.05 - sk[1]], [sx, -230 - sk[1]]], true);
      S.line('1:9', P.gl, [-1300, 0], [sx - F.mortar, 0]);
      out.skirt = sk;
    }
    // ground line on the inner side is the slab top; sill (土台) dashed on top
    S.rect('1:9', { color: 2, style: 2 }, -52.5, top, 52.5, top + 105); S.line('1:9', { color: 2, style: 2 }, [-52.5, top], [52.5, top + 105]); S.line('1:9', { color: 2, style: 2 }, [52.5, top], [-52.5, top + 105]);
    // bars: 1-D13 top and bottom, verticals D10@200 (line), horizontals D10@300 (dots), footing D13
    S.line(LB, P.bar, [0, fb + 60], [0, top - 50]); S.line(LB, P.bar, [0, top - 50], [-40, top - 50]);
    bar(0, top - 50); bar(0, fb + 60); bar(-130, fb + 60); bar(130, fb + 60);
    for (let y = ft + 150; y < top - 120; y += 300) bar(20, y);
    // anchor bolt M12 embedded 250
    S.line('1:7', { color: 1, style: 1 }, [25, top - 250], [25, top + 105 + 40]); S.line('1:7', { color: 1, style: 1 }, [25, top - 250], [60, top - 250]);
  } else {   // grade beam under the slab
    const w = F.gradeBeamWidth / 2;
    gravel(-w - 50, w + 50, gb, fb);
    S.rect(L1, P.c, -w, fb, w, slabB);
    S.solid(LF, [[-w, fb], [w, fb], [w, slabB], [-w, slabB]], 0xe6e6e6);
    for (const s of [-1, 1]) { const x0 = s * w, x1 = s * 1200; S.line(L1, P.c, [x0, epsB], [x1, epsB]); hatchV(x0, x1, epsB, slabB, 14); gravel(Math.min(x0, x1), Math.max(x0, x1), grvB, epsB); }
    S.line(L1, P.c, [-1200, slabT], [1200, slabT]); S.line(L1, P.c, [-1200, slabB], [-w, slabB]); S.line(L1, P.c, [w, slabB], [1200, slabB]);
    for (const x of [-w + 60, 0, w - 60]) { bar(x, fb + 60); bar(x, slabB + 50); }
    for (let x = -1150; x < 1150; x += 200) { bar(x, slabT - 50); }
  }
  // level marks
  const mark = (x, y, label, filled) => { if (filled) S.solid('1:9', [[x, y], [x - 50, y + 100], [x + 50, y + 100], [x + 50, y + 100]], 0); else S.poly('1:9', { color: 2, style: 1 }, [[x, y], [x - 50, y + 100], [x + 50, y + 100]], true); S.atext('1:9', [x - 60, y + 130], label, 3, { ax: 0, ay: 0 }); };
  if (kind !== 'beam') mark(-1100, top, '基礎天端', false);
  mark(-1100, 0, kind === 'beam' ? '耐圧版天端' : '設計GL', true);
  out.levels = { top, ft, fb, gb, slabT, slabB, epsB, grvB };
  return out;
}

function dimChain(S, x, vals, { vertical = true, side = -1 } = {}) {
  const P = (a, v) => vertical ? [x, v] : [v, x];
  S.line('1:E', { color: 1, style: 1 }, P(0, vals[0]), P(0, vals.at(-1)));
  for (const v of vals) S.point('1:E', P(0, v));
  for (let i = 1; i < vals.length; i++) {
    const m = (vals[i] + vals[i - 1]) / 2, t = fmt(vals[i] - vals[i - 1]);
    if (vertical) S.atext('1:E', [x + side * 15, m], t, 3, { angle: 90, ax: 0.5, ay: side < 0 ? 1 : 0 }); else S.atext('1:E', [m, x + 15], t, 3, { ax: 0.5, ay: 0 });
  }
  return vals;
}

export function drawFoundationDetails(input, { building: prebuilt } = {}) {
  const B = prebuilt ?? buildBuilding(input), b = B.building, F = b.foundation, warnings = [];
  const st = styleTable('fdetail');
  const panels = [];
  const kinds = [['perimeter', '基礎配筋詳細図 (外周部 FG1)'], [F.interior === 'grade-beam' ? 'beam' : 'interior', F.interior === 'grade-beam' ? '地中梁詳細図 (FG2)' : '基礎配筋詳細図 (内部立上り FG2)']];
  const info = { panels: [] };
  kinds.forEach(([kind, title], i) => {
    const S = new Sheet(DETAIL_SCALE, st), sec = foundationSection(S, b, kind), Lv = sec.levels;
    // dimension chains (measured on FG1: 1,060 = 400 + 660; 910 + 150; right: 180/100/230/150/100 = 760)
    if (kind !== 'beam') {
      sec.dims.left = [dimChain(S, -1600, [Lv.fb, Lv.top]), dimChain(S, -1450, [Lv.fb, 0, Lv.top]), dimChain(S, -1300, [Lv.gb, Lv.fb, Lv.ft, Lv.top])];
      sec.dims.right = [dimChain(S, 1450, [Lv.gb, Lv.fb, Lv.ft, Lv.epsB, Lv.slabB, Lv.slabT], { side: 1 }), dimChain(S, 1600, [Lv.fb, 0], { side: 1 })];
      sec.dims.bottom = [dimChain(S, Lv.gb - 250, [-F.footingWidth / 2, 0, F.footingWidth / 2], { vertical: false }), dimChain(S, Lv.gb - 450, [-F.footingWidth / 2, F.footingWidth / 2], { vertical: false })];
      sec.dims.top = [dimChain(S, b.levels.foundationTop + 350, [-F.riser / 2, F.riser / 2], { vertical: false })];
    } else {
      sec.dims.left = [dimChain(S, -1450, [Lv.gb, Lv.fb, Lv.slabB, Lv.slabT])];
      sec.dims.bottom = [dimChain(S, Lv.gb - 250, [-F.gradeBeamWidth / 2, F.gradeBeamWidth / 2], { vertical: false })];
    }
    // callouts with leaders
    const notes = kind === 'perimeter'
      ? [[[-150, 200], `基礎断熱 EPS 厚${F.edgeInsulation}`], [[0, b.levels.foundationTop - 50], '上端筋 1-D13'], [[0, 100], 'タテ筋 D10@200 / ヨコ筋 D10@300'], [[600, -90], `耐圧版 厚${F.slab} D13@200 タテヨコ`], [[600, -230], `土間下断熱 EPS 厚${F.slabInsulation}`], [[-500, -270], `スカート断熱 EPS 厚${F.skirt[1]}`], [[0, Lv.fb + 60], '下端筋 1-D13'], [[25, b.levels.foundationTop - 200], `アンカーボルト ${F.anchor.size} L=${F.anchor.length}`]]
      : kind === 'interior'
        ? [[[0, b.levels.foundationTop - 50], '上端筋 1-D13'], [[0, 100], 'タテ筋 D10@200 / ヨコ筋 D10@300'], [[600, -90], `耐圧版 厚${F.slab} D13@200 タテヨコ`], [[0, Lv.fb + 60], '下端筋 1-D13']]
        : [[[0, Lv.fb + 60], '地中梁主筋 (上下各) 3-D13'], [[0, (Lv.fb + Lv.slabB) / 2], 'STP D10@300'], [[600, -90], `耐圧版 厚${F.slab} D13@200 タテヨコ`]];
    notes.sort((p, q) => q[0][1] - p[0][1] || p[0][0] - q[0][0]);   // leaders ordered by target height: no crossings
    notes.forEach(([p, t], k) => {
      const ty = b.levels.foundationTop + 700 - k * 190, tx = 1400;
      S.line('1:D', { color: 1, style: 1 }, p, [tx - 120, ty]); S.line('1:D', { color: 1, style: 1 }, [tx - 120, ty], [tx - 20, ty]);
      S.atext('1:D', [tx, ty], t, 3, { ax: 0, ay: 0.5 });
    });
    sec.notes = notes.map(n => n[1]);
    const tb = S.atext('1:D', [0, Lv.gb - 900], `${title}  1/${DETAIL_SCALE}`, 4, { ax: 0.5, ay: 0.5 });
    S.rect('1:D', { color: 1, style: 1 }, tb.x1 - 50, tb.y1 - 40, tb.x2 + 50, tb.y2 + 40);
    panels.push(S); info.panels.push({ kind, title, dims: sec.dims, levels: Lv, notes: sec.notes });
  });
  // 人通口 elevation (riser seen from the side) + notes panel
  const S3 = new Sheet(DETAIL_SCALE, st), w = F.manholeWidth / 2, Lt = b.levels.foundationTop, ft = -F.footingBottom + F.footingThickness, slabT = F.slabTop;
  S3.poly('1:1', { color: 2, style: 1 }, [[-1300, Lt], [-w, Lt], [-w, slabT], [w, slabT], [w, Lt], [1300, Lt]]);
  S3.line('1:1', { color: 2, style: 1 }, [-1300, ft], [1300, ft]); S3.line('1:1', { color: 2, style: 1 }, [-1300, -F.footingBottom], [1300, -F.footingBottom]);
  S3.line('1:1', { color: 1, style: 1 }, [-1300, slabT], [-w, slabT]); S3.line('1:1', { color: 1, style: 1 }, [w, slabT], [1300, slabT]);
  for (const s of [-1, 1]) { S3.line('1:5', { color: 3, style: 1 }, [s * (w + 60), ft + 60], [s * (w + 60), Lt - 50]); S3.line('1:5', { color: 3, style: 1 }, [s * w - s * 300, slabT - 60], [s * (w + 400), slabT - 60]); }
  S3.line('1:5', { color: 3, style: 1 }, [-w - 400, slabT - 120], [w + 400, slabT - 120]);
  const mh = [dimChain(S3, slabT - 500, [-w, w], { vertical: false }), dimChain(S3, -1450, [-F.footingBottom, ft, slabT, Lt])];
  S3.atext('1:D', [0, Lt + 300], '開口補強筋 D13 (L=開口幅+800)', 3, { ax: 0.5, ay: 0 });
  const t3 = S3.atext('1:D', [0, -F.footingBottom - 700], `人通口詳細図 (立上り開口 W${F.manholeWidth})  1/${DETAIL_SCALE}`, 4, { ax: 0.5, ay: 0.5 });
  S3.rect('1:D', { color: 1, style: 1 }, t3.x1 - 50, t3.y1 - 40, t3.x2 + 50, t3.y2 + 40);
  info.panels.push({ kind: 'manhole', dims: { bottom: [mh[0]], left: [mh[1]] } });
  panels.push(S3);
  const S4 = new Sheet(DETAIL_SCALE, st);
  const notes = ['基礎仕様 (標準)', `1 地業: 砕石 厚${F.gravel} ランマー締め固め`, '2 コンクリート: Fc=21N/mm² (スランプ18cm)', '3 鉄筋: SD295A  かぶり厚さ 土に接する部分60以上', `4 基礎天端: 設計GL+${Lt}  耐圧版天端: 設計GL±${F.slabTop}`, `5 アンカーボルト: ${F.anchor.size} L=${F.anchor.length}  柱際${F.anchor.endOffset}以内・間隔${fmt(F.anchor.maxSpacing)}以内`, `6 鋼製束: @${F.postPitch} 格子`, '7 地盤: 地盤調査の結果により別途検討'];
  notes.forEach((t, k) => S4.atext('1:D', [0, -k * 200], t, k ? 3 : 4, { ax: 0, ay: 1 }));
  S4.rect('1:D', { color: 1, style: 1 }, -100, -notes.length * 200 - 60, S4.bbox()[2] + 100, 120);
  panels.push(S4); info.notes = notes;
  // layout: 2 x 2 panels on A3 (paper mm), centred in their cells
  const [ax1, ay1, ax2, ay2] = PAPER.area, cw = (ax2 - ax1) / 2, ch = (ay2 - ay1) / 2;
  const doc = newSheetDocument('fdetail', { 1: { name: '基礎詳細図', scale: DETAIL_SCALE } }, `fresco set-generator foundation-detail scale=${DETAIL_SCALE}`);
  panels.forEach((S, i) => {
    const bb = S.bbox(), cx = ax1 + cw * (i % 2) + cw / 2, cy = ay2 - ch * Math.floor(i / 2) - ch / 2, w2 = (bb[2] - bb[0]) / DETAIL_SCALE, h2 = (bb[3] - bb[1]) / DETAIL_SCALE;
    if (w2 > cw || h2 > ch) warnings.push(`detail panel ${i + 1} ${Math.round(w2)}x${Math.round(h2)} mm exceeds its ${Math.round(cw)}x${Math.round(ch)} mm cell`);
    S.translate([Math.round((cx * DETAIL_SCALE - (bb[0] + bb[2]) / 2) / 5) * 5, Math.round((cy * DETAIL_SCALE - (bb[1] + bb[3]) / 2) / 5) * 5]);
    emit(doc, S);
  });
  emit(doc, drawFrame(st, { ...B.spec.title, drawing: '基礎詳細図', scale: `1/${DETAIL_SCALE}`, sheet: 'S-02' }));
  return { bytes: finish(doc), doc, info, warnings: [...B.warnings, ...warnings], layout: {}, building: B };
}
export { onModule, subtractIntervals };
