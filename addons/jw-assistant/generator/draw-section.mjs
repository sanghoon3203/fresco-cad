// drawSection(spec) -> JWW bytes with the 断面詳細図 1/50 (A3) derived from the plan spec + building block.
// The cut runs along the roof slope (building.section, default: a 455 half-grid line near the middle that does
// not coincide with an interior wall). Layer / pen / build-up conventions measured from practice house A
// (knowledge/office-drafting-rules-section.json): structure 1:1, cut members 1:2, floor 1:3, insulation 1:A/1:C,
// colour fills 1:B, text 1:D, dimensions 1:E, gravel hatch 1:8, posts beyond 1:7.
import { buildBuilding, openingHeights } from './building.mjs';
import { Sheet, styleTable, newSheetDocument, emit, drawFrame, finish, fmt, PAPER } from './sheet.mjs';
import { pointOnSegment, near } from './geometry.mjs';

export const SCALE = 50;
export const PEN = {
  ground: { color: 6, style: 1 }, body: { color: 2, style: 1 }, thin: { color: 1, style: 1 }, batten: { color: 4, style: 1 }, member: { color: 2, style: 1 },
  insul: { color: 8, style: 1 }, addInsul: { color: 3, style: 1 }, hatch: { color: 1, style: 1 }, post: { color: 4, style: 1 }, level: { color: 4, style: 5 },
  dim: { color: 1, style: 1 }, dimMain: { color: 2, style: 1 }, mark: { color: 2, style: 1 }, box: { color: 1, style: 1 }, bubble: { color: 1, style: 1 }, stub: { color: 4, style: 5 }
};
export const TEXT = { callout: 3, dim: 7, level: 7, title: 4, room: 3, small: 10 };
export const BUBBLE = { h: 4, w: 4 };
export const LAYER = { ground: '1:0', body: '1:1', member: '1:2', floor: '1:3', post: '1:7', gravel: '1:8', insul: '1:A', fill: '1:B', addInsul: '1:C', text: '1:D', dim: '1:E' };
// measured offsets (mm): wall assembly as in the plan, roof layers below the roof top (vertical), foundation below GL
export const WALL = { out: -185, siding: -170, battenOut: -152, battenIn: -62, core: 52.5, in: 65 };
export const ROOF_LAYERS = { roofingBase: 10.6, sheathingBottom: 23.4, rafterBottom: 86.9 };
export const CEIL = { board: 12.5, joist: 45, insulation: 400 };
export const FOUND = { mortarFace: 190, gravelDepth: 760, footingTop: 510 };

const fill = { conc: 0xefefef, eps: 0xe5e5ff, white: 0xffffff };   // Jw solid colours are COLORREF (0xBBGGRR): practice EPS pink e5e5ff

function crossings(B) {
  const { model, section: X } = B, along = X.axis === 'y' ? 1 : 0, across = 1 - along, at = X.at;
  const P = u => (along === 1 ? [at, u] : [u, at]);
  const covers = (a, b) => Math.abs(a[along] - b[along]) < 0.5 && Math.min(a[across], b[across]) < at - 0.5 && Math.max(a[across], b[across]) > at + 0.5;
  const walls = model.walls.filter(w => covers(w.a, w.b)).map(w => {
    const u = w.a[along], inward = w.frame.n[along];               // ext: +1 => inside is toward +u
    const o = model.openings.find(op => op.wall === w.id && Math.min(op.jambs[0][across], op.jambs[1][across]) + 65 < at && Math.max(op.jambs[0][across], op.jambs[1][across]) - 65 > at);
    return { w, u, kind: w.kind, inward: w.kind === 'ext' ? Math.sign(inward) : 0, opening: o ?? null };
  }).sort((p, q) => p.u - q.u);
  const risers = [...B.foundation.risers.map(r => ({ ...r, beam: false })), ...B.foundation.beams.map(r => ({ ...r, beam: true }))].filter(r => covers(r.a, r.b)).map(r => ({ u: r.a[along], kind: r.kind, beam: r.beam })).sort((p, q) => p.u - q.u);
  // building intervals along the cut (between exterior crossings)
  const ext = walls.filter(w => w.kind === 'ext'), intervals = [];
  for (let i = 0; i + 1 < ext.length; i += 2) intervals.push([ext[i].u, ext[i + 1].u]);
  // rooms along the cut
  const rooms = [];
  for (const [a, b] of intervals) {
    let cur = null;
    for (let u = a + 50; u <= b - 50; u += 50) {
      const r = model.rooms.find(rm => rm.contains(P(u)));
      if (r?.name !== cur?.name) { if (cur) cur.u1 = u; cur = r ? { name: r.name, u0: u, kind: r.kind, room: r } : null; if (cur) rooms.push(cur); }
    }
    if (cur) cur.u1 = b;
  }
  return { walls, risers, intervals, rooms, P, along };
}

/** Draw one section in local coordinates (u along the cut, h above GL). */
function drawCut(B) {
  const S = new Sheet(SCALE, styleTable('section'));
  const { levels: L, roof, building: b } = B, F = b.foundation, X = crossings(B), info = { walls: [], heights: {}, rooms: [] };
  const sAt = u => roof.sOf(X.P(u)), topAt = u => roof.top(sAt(u));
  // ---------- foundation (practice: concrete light grey with sparse 45° hatch, EPS pink, gravel zigzag)
  const ext = X.walls.filter(w => w.kind === 'ext');
  const conc = (x0, y0, x1, y1) => {                       // concrete: grey fill + 45° hatch every 250 (1:8)
    const a = Math.min(x0, x1), c = Math.max(x0, x1), lo = Math.min(y0, y1), hi = Math.max(y0, y1);
    S.solid(LAYER.fill, [[a, lo], [c, lo], [c, hi], [a, hi]], fill.conc);
    for (let k = Math.ceil((a - hi) / 250) * 250; k < c - lo; k += 250) {
      const p0 = [Math.max(a, k + lo), 0], p1 = [Math.min(c, k + hi), 0]; p0[1] = p0[0] - k; p1[1] = p1[0] - k;
      if (p1[0] - p0[0] > 20) S.line(LAYER.gravel, PEN.hatch, p0, p1);
    }
  };
  const eps = (x0, y0, x1, y1) => { const a = Math.min(x0, x1), c = Math.max(x0, x1); S.solid(LAYER.fill, [[a, y0], [c, y0], [c, y1], [a, y1]], fill.eps); S.rect(LAYER.body, PEN.body, a, y0, c, y1); };
  const gravel = (x0, y0, x1, y1) => { const a = Math.min(x0, x1), c = Math.max(x0, x1); for (let x = a + 25; x < c - 25; x += 50) S.poly(LAYER.gravel, PEN.hatch, [[x, y0 + 12], [x + 25, y1 - 12], [x + 50 > c ? x + 25 : x + 50, y0 + 12]]); };
  const ySlabB = F.slabTop - F.slab, yEpsB = ySlabB - F.slabInsulation, yGrvB = yEpsB - F.slabGravel;
  for (const [ua, ub] of X.intervals) {
    // slab layers between the riser faces of this interval (inner EPS 50 hugs the exterior risers)
    const inner = [ua + F.riser / 2, ub - F.riser / 2];
    const cuts = X.risers.filter(r => r.u > ua + 1 && r.u < ub - 1 && !r.beam).map(r => [r.u - F.riser / 2, r.u + F.riser / 2]);
    const spans = []; let s0 = inner[0];
    for (const [c0, c1] of cuts.sort((p, q) => p[0] - q[0])) { spans.push([s0, c0]); s0 = c1; }
    spans.push([s0, inner[1]]);
    for (const [a0, c0] of spans) {
      const a = Math.abs(a0 - inner[0]) < 1 ? a0 + F.innerInsulation : a0, c = Math.abs(c0 - inner[1]) < 1 ? c0 - F.innerInsulation : c0;
      S.line(LAYER.body, PEN.body, [a0, F.slabTop], [c0, F.slabTop]);
      S.line(LAYER.body, PEN.body, [a, ySlabB], [c, ySlabB]);
      conc(a0, ySlabB, c0, F.slabTop);
      eps(a, yEpsB, c, ySlabB);
      S.line(LAYER.body, PEN.body, [a, yGrvB], [c, yGrvB]);
      gravel(a, yGrvB, c, yEpsB);
    }
    for (const r of X.risers.filter(r => r.u > ua + 1 && r.u < ub - 1)) {
      if (r.beam) {   // 地中梁 under the slab (600 wide, down to the footing level)
        const w = F.gradeBeamWidth / 2, y0 = -F.footingBottom + F.footingThickness;
        S.rect(LAYER.body, PEN.body, r.u - w, y0, r.u + w, yGrvB); conc(r.u - w, y0, r.u + w, yGrvB);
      } else {        // interior riser, monolithic with the slab
        const x0 = r.u - F.riser / 2, x1 = r.u + F.riser / 2;
        S.line(LAYER.body, PEN.body, [x0, F.slabTop], [x0, L.foundationTop]); S.line(LAYER.body, PEN.body, [x1, F.slabTop], [x1, L.foundationTop]); S.line(LAYER.body, PEN.body, [x0, L.foundationTop], [x1, L.foundationTop]);
        S.line(LAYER.body, PEN.body, [x0, yGrvB], [x0, ySlabB]); S.line(LAYER.body, PEN.body, [x1, yGrvB], [x1, ySlabB]); S.line(LAYER.body, PEN.body, [x0, yGrvB], [x1, yGrvB]);   // riser footing below the slab
        conc(x0, yGrvB, x1, L.foundationTop);
      }
    }
  }
  for (const w of ext) {
    const u = w.u, o = -w.inward;                    // o: outward direction along u
    const yFt = -FOUND.footingTop, yFb = -F.footingBottom, yG = -FOUND.gravelDepth;
    S.rect(LAYER.body, PEN.body, u - F.gravelWidth / 2, yG, u + F.gravelWidth / 2, yFb); gravel(u - F.gravelWidth / 2, yG, u + F.gravelWidth / 2, yFb);   // gravel under footing
    S.rect(LAYER.body, PEN.body, u - F.footingWidth / 2, yFb, u + F.footingWidth / 2, yFt); conc(u - F.footingWidth / 2, yFb, u + F.footingWidth / 2, yFt);  // footing 400 x 150
    const rIn = u - o * F.riser / 2, rOut = u + o * F.riser / 2;
    S.line(LAYER.body, PEN.body, [rOut, yFt], [rOut, L.foundationTop]); S.line(LAYER.body, PEN.body, [rIn, yFt], [rIn, L.foundationTop]);
    S.line(LAYER.body, PEN.body, [rOut, L.foundationTop], [rIn, L.foundationTop]);
    conc(rIn, yFt, rOut, L.foundationTop);
    const epsF = u + o * (F.riser / 2 + F.edgeInsulation), mort = u + o * FOUND.mortarFace;
    eps(rOut, yFt, epsF, L.foundationTop);                                                                  // EPS 100 outside (打込み)
    eps(rIn, yFt, rIn - o * F.innerInsulation, ySlabB);                                                     // EPS 50 inside, footing top .. slab bottom
    S.line(LAYER.body, PEN.body, [mort, -182], [mort, L.foundationTop]); S.line(LAYER.body, PEN.body, [mort, L.foundationTop], [epsF, L.foundationTop]);
    // skirt insulation 450 x 50 at GL-258, falling 5 % outward (FG1 detail)
    const k0 = epsF, k1 = epsF + o * F.skirt[0], ys = -258;
    S.solid(LAYER.fill, [[k0, ys], [k1, ys - 22], [k1, ys - 22 - F.skirt[1]], [k0, ys - F.skirt[1]]], fill.eps);
    S.poly(LAYER.body, PEN.thin, [[k0, ys], [k1, ys - 22], [k1, ys - 22 - F.skirt[1]], [k0, ys - F.skirt[1]]], true);
    info.walls.push({ u, kind: 'ext', outward: o, opening: w.opening?.id ?? null });
  }
  // ground (GL) outside the building on 1:0
  const uMin = Math.min(...ext.map(w => w.u)), uMax = Math.max(...ext.map(w => w.u));
  // ---------- floor: 土台 at walls, 大引 at 910, posts beyond, floor boards
  for (const w of ext) { S.rect(LAYER.member, PEN.member, w.u - 52.5, L.foundationTop, w.u + 52.5, L.sillTop); S.line(LAYER.member, PEN.thin, [w.u - 52.5, L.foundationTop], [w.u + 52.5, L.sillTop]); S.line(LAYER.member, PEN.thin, [w.u - 52.5, L.sillTop], [w.u + 52.5, L.foundationTop]); }
  for (const [ua, ub] of X.intervals) {
    S.line(LAYER.body, PEN.body, [ua + 52.5, L.sillTop], [ub - 52.5, L.sillTop]);
    S.line(LAYER.body, PEN.thin, [ua + WALL.in, L.FL - 12], [ub - WALL.in, L.FL - 12]);
    S.line(LAYER.body, PEN.body, [ua + WALL.in, L.FL], [ub - WALL.in, L.FL]);
    for (let u = Math.ceil((ua + 455) / 910) * 910; u < ub - 300; u += 910) {
      if (X.risers.some(r => Math.abs(r.u - u) < 200 && !r.beam) || X.walls.some(w => w.kind === 'int' && Math.abs(w.u - u) < 100)) continue;
      S.rect(LAYER.member, PEN.member, u - 52.5, L.foundationTop, u + 52.5, L.sillTop);
      S.line(LAYER.post, PEN.post, [u - 15, F.slabTop], [u - 15, L.foundationTop]); S.line(LAYER.post, PEN.post, [u + 15, F.slabTop], [u + 15, L.foundationTop]);
      S.line(LAYER.post, PEN.post, [u - 50, F.slabTop + 6], [u + 50, F.slabTop + 6]); S.line(LAYER.post, PEN.post, [u - 50, L.foundationTop - 6], [u + 50, L.foundationTop - 6]);
    }
  }
  // ---------- exterior walls
  for (const w of ext) {
    const o = -w.inward, s = sAt(w.u), beamTop = roof.beamTopAt(s), beamH = s > roof.depth / 2 ? 105 : b.levels.eaveBeam;
    const wallTop = roof.top(roof.sOf(X.P(w.u + o * 185))) - b.roof.soffitDrop;          // siding runs up to the soffit
    const V = v => w.u + o * -v;                                                         // v < 0 = outside (plan convention)
    const op = w.opening, oh = op ? openingHeights(op, b) : null, gaps = op ? [[L.FL + oh.sill, L.FL + oh.head]] : [];
    const seg = (layer, pen, v, y0, y1) => { let parts = [[y0, y1]]; for (const [g0, g1] of gaps) parts = parts.flatMap(([p, q]) => [[p, Math.min(q, g0)], [Math.max(p, g1), q]]).filter(([p, q]) => q - p > 5); for (const [p, q] of parts) S.line(layer, pen, [V(v), p], [V(v), q]); };
    seg(LAYER.body, PEN.body, WALL.out, 425, wallTop);
    seg(LAYER.body, PEN.thin, WALL.siding, 425, wallTop);
    seg(LAYER.body, PEN.batten, WALL.battenOut, 445, beamTop - 108);
    seg(LAYER.body, PEN.batten, WALL.battenIn, 445, beamTop - 22);
    seg(LAYER.body, PEN.thin, -WALL.core, L.sillTop, beamTop - beamH);
    seg(LAYER.body, PEN.thin, WALL.core, L.sillTop, beamTop - beamH);
    seg(LAYER.body, PEN.body, WALL.in, L.FL, L.ceiling);
    S.rect(LAYER.member, PEN.member, w.u - 52.5, beamTop - beamH, w.u + 52.5, beamTop);                               // 桁
    S.line(LAYER.member, PEN.thin, [w.u - 52.5, beamTop - beamH], [w.u + 52.5, beamTop]); S.line(LAYER.member, PEN.thin, [w.u - 52.5, beamTop], [w.u + 52.5, beamTop - beamH]);
    // insulation: GW wave inside the core (±35), PF hatch in the -152..-62 band
    const insulRuns = (y0, y1) => { let parts = [[y0, y1]]; for (const [g0, g1] of gaps) parts = parts.flatMap(([p, q]) => [[p, Math.min(q, g0 - 20)], [Math.max(p, g1 + 20), q]]).filter(([p, q]) => q - p > 60); return parts; };
    for (const [p, q] of insulRuns(L.sillTop + 20, beamTop - beamH - 20)) {
      const n = Math.floor((q - p) / 17.5);
      for (let k = 0; k < n; k++) S.line(LAYER.insul, PEN.insul, [w.u + (k % 2 ? 35 : -35), p + 17.5 * k], [w.u + ((k + 1) % 2 ? 35 : -35), p + 17.5 * (k + 1)]);
    }
    for (const [p, q] of insulRuns(450, beamTop - 110)) for (let y = p; y < q - 90; y += 42.4) S.line(LAYER.addInsul, PEN.addInsul, [V(WALL.battenOut), y], [V(WALL.battenIn), y + 90]);
    if (op) {                      // window cut: frame box, glass, window board, closing lines at sill/head
      const y0 = L.FL + oh.sill, y1 = L.FL + oh.head;
      S.rect('1:4', PEN.thin, V(-217), y0, V(-87), y1);
      S.line('1:4', PEN.thin, [V(-157), y0 + 40], [V(-157), y1 - 40]); S.line('1:4', PEN.thin, [V(-116), y0 + 40], [V(-116), y1 - 40]);
      S.line(LAYER.body, PEN.body, [V(WALL.out), y0], [V(-217), y0]); S.line(LAYER.body, PEN.body, [V(WALL.out), y1], [V(-217), y1]);
      S.line(LAYER.body, PEN.body, [V(-87), y1], [V(WALL.in), y1]);
      if (oh.sill > 0) S.rect(LAYER.body, PEN.thin, V(-87), y0 - 25, V(WALL.in + 15), y0);
    }
    info.walls.find(x => x.u === w.u).top = wallTop;
    info.walls.find(x => x.u === w.u).beamTop = beamTop;
  }
  // interior walls cut by the section
  for (const w of X.walls.filter(x => x.kind === 'int')) {
    for (const v of [-65, 65]) S.line(LAYER.body, PEN.body, [w.u + v, L.FL], [w.u + v, L.ceiling]);
    for (const v of [-52.5, 52.5]) S.line(LAYER.body, PEN.thin, [w.u + v, L.FL], [w.u + v, L.ceiling]);
    info.walls.push({ u: w.u, kind: 'int' });
  }
  // ---------- ceiling + insulation
  for (const [ua, ub] of X.intervals) {
    const a = ua + WALL.in, c = ub - WALL.in;
    S.line(LAYER.body, PEN.body, [a, L.ceiling], [c, L.ceiling]);
    S.line(LAYER.body, PEN.thin, [a, L.ceiling + CEIL.board], [c, L.ceiling + CEIL.board]);
    S.line(LAYER.body, PEN.thin, [a + 45, L.ceiling + CEIL.board + CEIL.joist], [c - 45, L.ceiling + CEIL.board + CEIL.joist]);
    const y0 = L.ceiling + CEIL.board, y1 = y0 + CEIL.insulation;
    S.line(LAYER.gravel, PEN.thin, [a, y1], [c, y1]);
    const step = 70.7;
    for (let k = a - CEIL.insulation; k < c; k += step) {               // ±45° cross hatch clipped to [a,c] x [y0,y1]
      for (const d of [1, -1]) {
        let p0 = d > 0 ? [k, y0] : [k + CEIL.insulation, y0], p1 = d > 0 ? [k + CEIL.insulation, y1] : [k, y1];
        const clip = (p, q) => { const t0 = Math.max(0, d > 0 ? (a - p[0]) / (q[0] - p[0]) : (p[0] - c) / (p[0] - q[0])), t1 = Math.min(1, d > 0 ? (c - p[0]) / (q[0] - p[0]) : (p[0] - a) / (p[0] - q[0])); return t1 > t0 ? [[p[0] + (q[0] - p[0]) * t0, p[1] + (q[1] - p[1]) * t0], [p[0] + (q[0] - p[0]) * t1, p[1] + (q[1] - p[1]) * t1]] : null; };
        const r = clip(p0, p1); if (r) S.line(LAYER.insul, PEN.insul, r[0], r[1]);
      }
    }
    info.ceiling = { y: L.ceiling, insulationTop: y1 };
  }
  // ---------- roof
  const roofSpans = X.intervals.map(([ua, ub]) => {
    const sa = sAt(ua), sb = sAt(ub), lowFirst = sa <= sb, flat = Math.abs(sa - sb) < 1;
    const ea = flat ? b.roof.eaves.gable : (lowFirst ? b.roof.eaves.low : b.roof.eaves.high), eb = flat ? b.roof.eaves.gable : (lowFirst ? b.roof.eaves.high : b.roof.eaves.low);
    return [ua - ea, ub + eb];
  });
  info.roof = [];
  for (const [ra, rb] of roofSpans) {
    const T = (u, dy = 0) => [u, roof.top(roof.sOf(X.P(u))) - dy];
    S.line(LAYER.body, PEN.body, T(ra), T(rb));
    S.line(LAYER.body, PEN.thin, T(ra + 13, ROOF_LAYERS.roofingBase), T(rb - 13, ROOF_LAYERS.roofingBase));
    S.line(LAYER.body, PEN.thin, T(ra + 45, ROOF_LAYERS.sheathingBottom), T(rb - 45, ROOF_LAYERS.sheathingBottom));
    S.line(LAYER.body, PEN.thin, T(ra + 93, ROOF_LAYERS.rafterBottom), T(rb - 60, ROOF_LAYERS.rafterBottom));          // rafter underside = beam-top plane
    for (const [u, dir] of [[ra, 1], [rb, -1]]) {                                                                // fascia + soffit board back to the wall
      const t = T(u), fb = [u, t[1] - 205.8];
      S.poly(LAYER.body, PEN.body, [t, fb, [u + dir * 28, fb[1]], [u + dir * 28, t[1] - 10]], false);
      const wallU = ext.reduce((best, w) => Math.abs(w.u - u) < Math.abs(best - u) ? w.u : best, ext[0].u), face = wallU - dir * 185;
      const ys = q => roof.top(roof.sOf(X.P(q))) - b.roof.soffitDrop;
      S.line(LAYER.body, PEN.body, [u + dir * 28, ys(u + dir * 28)], [face, ys(face)]);
      S.line(LAYER.body, PEN.thin, [u + dir * 28, ys(u + dir * 28) + 12], [face, ys(face) + 12]);
    }
    info.roof.push({ from: ra, to: rb, topFrom: T(ra)[1], topTo: T(rb)[1] });
  }
  // roof framing: tie beams at the eave-beam top, posts (束) at 1,820 and purlins (母屋) under the rafters
  for (const [ua, ub] of X.intervals) {
    const yb = L.eave;
    S.line(LAYER.body, PEN.thin, [ua + 65, yb], [ub - 65, yb]); S.line(LAYER.body, PEN.thin, [ua + 65, yb - 105], [ub - 65, yb - 105]);
    for (let u = Math.ceil((ua + 1000) / 1820) * 1820; u < ub - 800; u += 1820) {
      const rb = roof.top(roof.sOf(X.P(u))) - ROOF_LAYERS.rafterBottom;
      if (rb - yb < 300) continue;
      S.line(LAYER.body, PEN.thin, [u - 52.5, yb], [u - 52.5, rb - 105]); S.line(LAYER.body, PEN.thin, [u + 52.5, yb], [u + 52.5, rb - 105]);
      S.rect(LAYER.member, PEN.member, u - 52.5, rb - 105, u + 52.5, rb);
      S.line(LAYER.member, PEN.thin, [u - 52.5, rb - 105], [u + 52.5, rb]); S.line(LAYER.member, PEN.thin, [u - 52.5, rb], [u + 52.5, rb - 105]);
    }
  }
  // ---------- room labels (boxed, mid-height)
  for (const r of X.rooms.filter(r => r.u1 - r.u0 > 700)) {
    const c = [(r.u0 + r.u1) / 2, L.FL + 1500], box = S.atext(LAYER.text, c, r.name, TEXT.room, { ax: 0.5, ay: 0.5 });
    S.rect(LAYER.text, PEN.box, box.x1 - 60, box.y1 - 60, box.x2 + 60, box.y2 + 60);
    info.rooms.push(r.name);
  }
  info.heights = { ...L, max: roof.maxHeight };
  return { S, X, info, uMin, uMax, roofSpans };
}

function annotate(B, cut) {
  const { S, X, info, roofSpans } = cut, { levels: L, roof, building: b } = B, F = b.foundation;
  const rMin = Math.min(...roofSpans.map(r => r[0])), rMax = Math.max(...roofSpans.map(r => r[1]));
  const top = roof.maxLabel;
  // ground line outside + labels on both sides
  const xL = rMin - 3500, xR = rMax + 3500;
  S.line(LAYER.ground, PEN.ground, [xL + 600, 0], [cut.uMin - 190, 0]); S.line(LAYER.ground, PEN.ground, [cut.uMax + 190, 0], [xR - 600, 0]);
  const levels = [[`最高の高さ GL+${fmt(top)}`, top], [`軒高 GL+${fmt(L.eave)}`, L.eave], [`1FL GL+${fmt(L.FL)}`, L.FL], ['設計GL', 0]];
  for (const [side, x0] of [[-1, xL], [1, xR]]) {
    for (const [name, y] of levels) {
      const col0 = (side < 0 ? rMin : rMax) + side * 2700, tw = S.textLen(name, TEXT.level) * SCALE, xm = col0 + side * (150 + tw + 200);
      if (y === 0) S.solid(LAYER.fill, [[xm, 0], [xm - 100, 200], [xm + 100, 200], [xm + 100, 200]], 0x000000);
      else S.poly(LAYER.text, PEN.mark, [[xm, y], [xm - 100, y + 200], [xm + 100, y + 200]], true);
      S.atext(LAYER.text, [col0 + side * 150, y + 15], name, TEXT.level, { ax: side < 0 ? 1 : 0, ay: 0 });
      if (y > 0) S.line(LAYER.dim, PEN.level, [xm + side * 150, y], [side < 0 ? rMin - 200 : rMax + 200, y]);
    }
  }
  // vertical chains (both sides): overall, main, structure, ceiling, foundation below GL
  const chain = (x, vals, layer, pen) => {
    S.line(layer, pen, [x, vals[0]], [x, vals.at(-1)]);
    for (const y of vals) S.point(layer, [x, y]);
    let flip = false;
    for (let i = 1; i < vals.length; i++) { const sh = vals[i] - vals[i - 1] < 250; flip = sh ? !flip : false; S.atext(layer, [flip ? x + 15 : x - 15, (vals[i] + vals[i - 1]) / 2], fmt(vals[i] - vals[i - 1]), TEXT.dim, { angle: 90, ax: 0.5, ay: flip ? 0 : 1 }); }
    return vals;
  };
  info.chains = {};
  for (const [side, edge] of [[-1, rMin], [1, rMax]]) {
    const col = k => edge + side * (2700 - k * 400);
    const tag = side < 0 ? 'L' : 'R';
    info.chains[tag] = {
      overall: chain(col(0), [0, top], LAYER.dim, PEN.dimMain),
      main: chain(col(1), [0, L.FL, L.eave, top], LAYER.dim, PEN.dimMain),
      structure: chain(col(2), [0, L.foundationTop, L.sillTop, L.beamBottom, L.eave], LAYER.dim, PEN.dim),
      ceiling: chain(col(3), [L.sillTop, L.FL, L.ceiling], LAYER.dim, PEN.dim),
      below: chain(col(1), [-FOUND.gravelDepth, -F.footingBottom, -FOUND.footingTop, 0], LAYER.dim, PEN.dim),
      belowFooting: chain(col(2), [-F.footingBottom, 0], LAYER.dim, PEN.dim),
      belowAll: chain(col(0), [-FOUND.gravelDepth, 0], LAYER.dim, PEN.dim)
    };
    S.atext(LAYER.text, [col(2) + 160, (L.sillTop + L.beamBottom) / 2], '横架材間距離', 0, { angle: 90, size: { h: 2.8, w: 2.8 } });
    S.atext(LAYER.text, [col(3) + 160, (L.FL + L.ceiling) / 2], '天井高', 0, { angle: 90, size: { h: 2.8, w: 2.8 } });
    for (const y of [L.foundationTop, L.sillTop, L.FL, L.beamBottom, L.ceiling]) S.line(LAYER.dim, PEN.dim, [col(3) + side * 0, y], [edge + side * 400, y]);
  }
  // top: grid bubbles for every grid line in the building range + two tiers; bottom: grid tier + overall + footing widths
  const g = B.spec.grid, vals = X.along === 1 ? g.y : g.x, labs = X.along === 1 ? g.yLabels : g.xLabels;
  const inRange = vals.map((v, i) => [v, labs[i]]).filter(([v]) => v >= cut.uMin - 1 && v <= cut.uMax + 1);
  const yTop = Math.max(...info.roof.map(r => Math.max(r.topFrom, r.topTo))) + 1300, yT2 = yTop + 250, yB = yT2 + 900;
  const tier = (vs, y, pen) => { S.line(LAYER.dim, pen, [vs[0], y], [vs.at(-1), y]); for (const u of vs) S.point(LAYER.dim, [u, y]); for (let i = 1; i < vs.length; i++) S.atext(LAYER.dim, [(vs[i] + vs[i - 1]) / 2, y + 30], fmt(vs[i] - vs[i - 1]), TEXT.dim, { ax: 0.5, ay: 0 }); return vs; };
  const walls = [...new Set(X.walls.map(w => w.u))].sort((p, q) => p - q);
  info.tiers = { top1: tier([rMin, ...walls, rMax], yTop, PEN.dimMain), top2: tier([cut.uMin, cut.uMax], yT2, PEN.dimMain) };
  for (const u of [rMin, rMax]) S.line(LAYER.dim, { color: 7, style: 1 }, [u, yTop], [u, roof.top(roof.sOf(X.P(u))) + 200]);
  for (const [v, lab] of inRange) {
    S.line(LAYER.text, PEN.stub, [v, yT2], [v, yB - 250]); S.arc(LAYER.text, PEN.bubble, [v, yB], 250);
    S.atext(LAYER.text, [v, yB], lab, 0, { ax: 0.5, ay: 0.5, size: { h: 4, w: Math.min(4, 4.4 / Math.max(1, [...lab].length / 2)) } });
    S.line(LAYER.dim, PEN.stub, [v, yTop], [v, roof.top(roof.sOf(X.P(v))) + 150]);
  }
  const yBot1 = -FOUND.gravelDepth - 900, yBot2 = yBot1 - 250;
  info.tiers.bottom1 = tier(walls, yBot1, PEN.dimMain); info.tiers.bottom2 = tier([cut.uMin, cut.uMax], yBot2, PEN.dimMain);
  for (const u of walls) S.line(LAYER.dim, PEN.stub, [u, yBot1], [u, -FOUND.gravelDepth - 100]);
  for (const w of X.walls.filter(x => x.kind === 'ext')) {   // footing width 400 under each exterior wall
    const y = -FOUND.gravelDepth - 400; tier([w.u - F.footingWidth / 2, w.u + F.footingWidth / 2], y, PEN.dim);
  }
  // build-up callouts: roof (top-left), wall (top-right), interior (left), foundation (bottom with leader)
  const callout = (x, y, title, lines, ax = 0) => {
    const items = [title, ...lines.map(t => `・${t}`)], hLine = 3.2 * SCALE * 1.35;
    const w = Math.max(...items.map(t => S.textLen(t, TEXT.callout))) * SCALE + 200, h = items.length * hLine + 120, x0 = x - ax * w;
    S.rect(LAYER.text, PEN.box, x0, y - h, x0 + w, y);
    items.forEach((t, i) => S.atext(LAYER.text, [x0 + 100, y - 100 - (i + 0.8) * hLine + hLine * 0.3], t, TEXT.callout, { ax: 0, ay: 0 }));
    return { x1: x0, y1: y - h, x2: x0 + w, y2: y };
  };
  const yC = yB + 250;
  const roofBox = callout(rMin - 250, yC, '屋根', b.buildUps.roof, 1);
  info.callouts = [
    roofBox,
    callout(rMax + 250, yC, '外壁 (断熱部)', b.buildUps.wall, 0),
    callout(rMin - 250, roofBox.y1 - 80, '室内 壁・天井', [...b.buildUps.interior, ...b.buildUps.ceiling.slice(0, 1)], 1)
  ];
  const fx = cut.uMax - 1200, fy = -FOUND.gravelDepth - 150;
  const fb = callout(cut.uMax + 700, fy + 200, '床・基礎', [...b.buildUps.floor.slice(0, 2), ...b.buildUps.foundation]);
  S.line(LAYER.text, PEN.box, [fx, F.slabTop - 90], [fx, fy + 200]);
  S.line(LAYER.text, PEN.box, [fx, fy + 200], [cut.uMax + 700, fy + 200]);
  info.callouts.push(fb);
  // title
  const tc = [(cut.uMin + cut.uMax) / 2, yBot2 - 800], r = S.atext(LAYER.text, tc, `断面詳細図 1/${SCALE}`, TEXT.title, { ax: 0.5, ay: 0.5 });
  S.rect(LAYER.text, PEN.box, r.x1 - 100, r.y1 - 80, r.x2 + 100, r.y2 + 80);
  info.levelLabels = levels.map(l => l[0]);
}

/** Draw the section sheet. Returns { bytes, doc, info, layout, warnings, building }. */
export function drawSection(input, { building: prebuilt } = {}) {
  const B = prebuilt ?? buildBuilding(input), warnings = [];
  const cut = drawCut(B);
  if (!cut.X.intervals.length) throw Object.assign(new Error('E_SPEC: section line does not cross the building'), { code: 'E_SPEC', details: ['section.at'] });
  annotate(B, cut);
  const S = cut.S, bb = S.bbox(), [ax1, ay1, ax2, ay2] = PAPER.area;
  const w = (bb[2] - bb[0]) / SCALE, h = (bb[3] - bb[1]) / SCALE;
  if (w > ax2 - ax1 || h > ay2 - ay1) warnings.push(`section ${Math.round(w)}x${Math.round(h)} mm exceeds the A3 drawing area at 1/${SCALE}`);
  const d = [Math.round(((ax1 + ax2) / 2 * SCALE - (bb[0] + bb[2]) / 2) / 10) * 10, Math.round(((ay1 + ay2) / 2 * SCALE - (bb[1] + bb[3]) / 2) / 10) * 10];
  S.translate(d);
  const doc = newSheetDocument('section', { 1: { name: '断面詳細図', scale: SCALE } }, `fresco set-generator section scale=${SCALE} cut=${B.section.axis}@${B.section.at}`);
  emit(doc, S);
  emit(doc, drawFrame(styleTable('section'), { ...B.spec.title, drawing: '断面詳細図', scale: `1/${SCALE}`, sheet: 'A-21' }));
  return { bytes: finish(doc), doc, info: { ...cut.info, cut: B.section }, layout: { offset: d, bbox: S.bbox(), fits: !warnings.length }, warnings: [...B.warnings, ...warnings], building: B };
}
export { near, pointOnSegment };
