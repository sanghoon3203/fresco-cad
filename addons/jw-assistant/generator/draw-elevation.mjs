// drawElevations(spec) -> JWW bytes with the four elevations (立面図 1/100, A3), derived from the plan spec +
// building block (generator/building.mjs). Layers / pens / text styles follow the measured office elevation
// sheet (knowledge/office-drafting-rules-elevation.json): group 1 at 1/100, group 0 = neutral A3 frame.
import { buildBuilding, openingHeights, ceil5 } from './building.mjs';
import { Sheet, styleTable, newSheetDocument, emit, drawFrame, finish, fmt, PAPER } from './sheet.mjs';
import { onModule } from './spec.mjs';

export const SCALE = 100;
export const PEN = {
  outline: { color: 6, style: 1 }, ground: { color: 2, style: 1 }, thin: { color: 1, style: 1 }, roofing: { color: 3, style: 1 }, fasciaMid: { color: 4, style: 1 },
  level: { color: 1, style: 1 }, levelChain: { color: 4, style: 5 }, dim: { color: 1, style: 1 }, dimTop: { color: 2, style: 1 }, gridStub: { color: 4, style: 5 },
  bubble: { color: 1, style: 1 }, mark: { color: 2, style: 1 }, member: { color: 113, style: 31 }, sash: { color: 7, style: 1 }, handle: { color: 2, style: 1 },
  siding: { color: 3, style: 1 }, slope: { color: 1, style: 1 }, corner: { color: 1, style: 1 }, eaveDim: { color: 7, style: 1 }
};
export const TEXT = { label: 8, dim: 8, grid: 3, title: 4, slope: 1 };
export const SMALL = { h: 2.3, w: 2.1 }, VLABEL = { h: 2.5, w: 2.2 };
export const LAYER = { level: '1:0', outline: '1:1', member: '1:2', corner: '1:3', opening: '1:5', hatch: '1:8', slope: '1:9', fill: '1:B', text: '1:D', dim: '1:E' };
export const MEASURED = {
  sidingBottom: 425, foundationFace: 190, drip: [395, 425, 212], sidingPitch: 50.3, groundBand: [12, 660], titleGap: 1082, titleBoxH: 460,
  glassInset: 50, frameInset: 25, bubbleR: 240, tierGap: 400, tierAboveTop: 2055, bubbleAbove: 1200, extTop: 800,
  chain: { labelStart: 5210, solidEnd: 785, mark: 3543, cols: [3043, 2643, 2243, 1843, 1443], chainBeyond: 2415 }
};

const fillRgb = { ground: 0xe6e6e6, foundation: 0xf5f5f5, soffit: 0xececec, roof: 0xdedede, glass: 0x999999, black: 0x000000 };

/** One elevation in local coordinates: u (left->right as seen), h above GL. Returns {S, extent, chainSide, info}. */
function drawView(B, side, chainSide) {
  const S = new Sheet(SCALE, styleTable('elevation'));
  const { roof, levels: L, facades } = B, F = facades[side], b = B.building;
  const profile = (roof.axis === 'y') === (side === 'E' || side === 'W');
  const isLow = side === roof.low, M = MEASURED;
  const axisVec = roof.axis === 'y' ? [0, 1] : [1, 0], ud = F.uDir[0] * axisVec[0] + F.uDir[1] * axisVec[1];
  const uOfS = s => ud * (s * roof.sign + roof.s0), sOfU = u => roof.sOf([F.uDir[0] * u, F.uDir[1] * u]);
  const info = { side, profile, faces: [], openings: [], levels: {} };
  // ---- roof extent along u
  let uR0, uR1;
  if (profile) { [uR0, uR1] = [uOfS(roof.sMin), uOfS(roof.sMax)].sort((p, q) => p - q); }
  else { uR0 = F.uMin - roof.eaves.gable; uR1 = F.uMax + roof.eaves.gable; }
  const wallTop = u => profile ? roof.soffit(sOfU(u)) : null;

  // ---- walls, foundation, siding per visible face interval
  for (const f of F.faces) for (const [ua, ub] of f.visible) {
    const sFace = roof.sOf(f.wall.a);
    const top = profile ? wallTop : () => roof.soffit(isLow ? sFace - 185 : sFace + 185);
    const tA = top(ua), tB = top(ub);
    S.line(LAYER.outline, PEN.outline, [ua, M.sidingBottom], [ua, tA]);
    S.line(LAYER.outline, PEN.outline, [ub, M.sidingBottom], [ub, tB]);
    if (!profile) S.line(LAYER.outline, PEN.outline, [ua, tA], [ub, tB]);
    // foundation (face 5 mm proud of the siding) + drip flashing 395..425, projecting 27
    const fa = ua - (M.foundationFace - 185), fb = ub + (M.foundationFace - 185);
    S.solid(LAYER.fill, [[fa, 0], [fa, M.drip[0]], [fb, M.drip[0]], [fb, 0]], fillRgb.foundation);
    S.line(LAYER.outline, PEN.outline, [fa, 0], [fa, M.drip[0]]); S.line(LAYER.outline, PEN.outline, [fb, 0], [fb, M.drip[0]]);
    const da = ua - (M.drip[2] - 185), db = ub + (M.drip[2] - 185);
    S.line(LAYER.outline, PEN.thin, [fa, M.drip[0]], [fb, M.drip[0]]); S.line(LAYER.outline, PEN.thin, [ua, M.drip[1]], [ub, M.drip[1]]);
    for (const [x, xd] of [[fa, da], [fb, db]]) S.poly(LAYER.outline, PEN.outline, [[x, M.drip[0]], [xd, M.drip[0]], [xd, M.drip[1]], [x + (x === fa ? 5 : -5), M.drip[1]]]);
    // corner trim lines (1:3) 57 inside each face end
    S.line(LAYER.corner, PEN.corner, [ua + 57, M.drip[1]], [ua + 57, top(ua + 57) - 20]);
    S.line(LAYER.corner, PEN.corner, [ub - 57, M.drip[1]], [ub - 57, top(ub - 57) - 20]);
    info.faces.push({ wall: f.wall.id, u0: ua, u1: ub, topA: tA, topB: tB });
  }
  // ---- openings
  const holes = [];
  for (const op of F.openings) {
    const o = op.o, h = openingHeights(o, b), y0 = L.FL + h.sill, y1 = L.FL + h.head, [u0, u1] = [op.u0, op.u1];
    holes.push([u0, u1, y0, y1]);
    info.openings.push({ id: o.id, type: o.type, u0, u1, y0, y1 });
    const i1 = M.frameInset, g = M.glassInset;
    S.rect(LAYER.opening, PEN.sash, u0, y0, u1, y1);
    if (o.type === 'window-sliding') {
      S.rect(LAYER.opening, PEN.sash, u0 + i1, y0 + i1, u1 - i1, y1 - i1);
      const mid = (u0 + u1) / 2;
      for (const [a, c] of [[u0 + g, mid - 10], [mid + 10, u1 - g]]) { S.solid(LAYER.opening, [[a, y0 + g], [c, y0 + g], [c, y1 - g], [a, y1 - g]], fillRgb.glass); S.rect(LAYER.opening, PEN.sash, a, y0 + g, c, y1 - g); }
    } else if (o.type === 'entrance-door' || o.type === 'door-swing') {
      const leafW = Math.min(o.leaf ?? (u1 - u0), u1 - u0 - 2 * i1), hingeLeft = (op.uc < (u0 + u1) / 2) === !o.hingeAtR0;
      const la = hingeLeft ? u0 + i1 : u1 - i1 - leafW, lb = la + leafW;
      S.rect(LAYER.opening, PEN.sash, la, y0 + 10, lb, y1 - i1);
      if (u1 - u0 - 2 * i1 - leafW > 60) { const fa = hingeLeft ? lb : u0 + i1, fb = hingeLeft ? u1 - i1 : la; S.solid(LAYER.opening, [[fa + g, y0 + 300], [fb - g, y0 + 300], [fb - g, y1 - g - i1], [fa + g, y1 - g - i1]], fillRgb.glass); S.rect(LAYER.opening, PEN.sash, fa + g, y0 + 300, fb - g, y1 - g - i1); }
      const hx = hingeLeft ? lb - 90 : la + 90;
      S.line(LAYER.opening, PEN.handle, [hx, L.FL + 1000], [hx, L.FL + 1250]);
    } else S.rect(LAYER.opening, PEN.sash, u0 + i1, y0, u1 - i1, y1 - i1);
  }
  // ---- siding hatch (縦張り) on 1:8, clipped by openings and the wall top
  for (const fi of info.faces) for (let u = fi.u0 + M.sidingPitch; u < fi.u1 - 1; u += M.sidingPitch) {
    const top = profile ? wallTop(u) : fi.topA;
    let parts = [[M.sidingBottom, top]];
    for (const [a, c, y0, y1] of holes) if (u > a - 1 && u < c + 1) parts = parts.flatMap(([p, q]) => [[p, Math.min(q, y0)], [Math.max(p, y1), q]]).filter(([p, q]) => q - p > 5);
    for (const [p, q] of parts) S.line(LAYER.hatch, PEN.siding, [u, p], [u, q]);
  }
  // ---- roof
  if (profile) {
    const sA = roof.sMin, sB = roof.sMax, P = (s, dy = 0) => [uOfS(s), roof.top(s) - dy];
    S.line(LAYER.outline, PEN.outline, P(sA), P(sB));
    S.line(LAYER.outline, PEN.roofing, P(sA + 30, b.roof.roofing), P(sB - 5, b.roof.roofing));
    S.line(LAYER.outline, PEN.thin, P(sA + 56, b.roof.underside), P(sB - 7, b.roof.underside));
    for (const s of [sA, sB]) S.line(LAYER.outline, PEN.outline, P(s), P(s, b.roof.soffitDrop));                        // fascia
    // soffit band between the roof underside and the soffit line (gable eave seen from the side)
    S.solid(LAYER.fill, [P(sA + 115, b.roof.soffitDrop), P(sA + 56, b.roof.underside), P(sB - 37, b.roof.underside), P(sB - 37, b.roof.soffitDrop)], fillRgb.soffit);
    S.line(LAYER.outline, PEN.outline, P(sA, b.roof.soffitDrop), P(sB, b.roof.soffitDrop));
    // slope mark 10 / 3.5 above the roof, 1/3 from the high end
    const sm = roof.sMin + (roof.sMax - roof.sMin) * 0.55, base = P(sm), run = 1278, rise = run * roof.slope, dir = Math.sign(uOfS(sB) - uOfS(sA));
    const p0 = [base[0] - dir * run / 2, base[1] + 1300], p1 = [p0[0] + dir * run, p0[1]], p2 = [p0[0], p0[1] - rise];
    S.poly(LAYER.slope, PEN.slope, [p1, p0, p2], false); S.line(LAYER.slope, PEN.slope, p2, p1);
    S.atext(LAYER.slope, [(p0[0] + p1[0]) / 2 + dir * 100, p0[1] + 20], '10', TEXT.slope, { ax: 0.5, ay: 0 });
    S.atext(LAYER.slope, [p0[0] - dir * 90, (p0[1] + p2[1]) / 2], String(roof.slope * 10), TEXT.slope, { ax: dir > 0 ? 1 : 0, ay: 0.5 });
    info.slopeMark = { run, rise, text: [String(10), String(roof.slope * 10)] };
  } else if (isLow) {
    // roof plane seen from the low eave: per face strip from its fascia up to the top (max height)
    const strips = F.faces.flatMap(f => f.visible.map(([a, c]) => ({ a, c, s: roof.sOf(f.wall.a) }))).sort((p, q) => p.a - q.a);
    strips[0].a = uR0; strips.at(-1).c = uR1;
    for (let i = 1; i < strips.length; i++) { const m = (strips[i - 1].c + strips[i].a) / 2; strips[i - 1].c = m; strips[i].a = m; }
    const top = roof.maxHeight;
    for (const st of strips) {
      const yE = roof.top(st.s - roof.eaves.low);
      S.solid(LAYER.fill, [[st.a, yE], [st.c, yE], [st.c, top], [st.a, top]], fillRgb.roof);
      S.line(LAYER.outline, PEN.outline, [st.a, yE], [st.c, yE]);
      S.line(LAYER.outline, PEN.fasciaMid, [st.a, yE - 9.4], [st.c, yE - 9.4]);
      S.line(LAYER.outline, PEN.thin, [st.a + 15, yE - 48.6], [st.c - 15, yE - 48.6]);
      S.solid(LAYER.fill, [[st.a + 45, yE - 205.8], [st.a + 45, yE - 48.6], [st.c - 45, yE - 48.6], [st.c - 45, yE - 205.8]], fillRgb.soffit);
      S.line(LAYER.outline, PEN.outline, [st.a + 45, yE - 205.8], [st.c - 45, yE - 205.8]);
      info.eaves = [...(info.eaves ?? []), yE];
    }
    S.line(LAYER.outline, PEN.outline, [uR0, top], [uR1, top]);
    S.line(LAYER.outline, PEN.outline, [uR0, roof.top(strips[0].s - roof.eaves.low) - 9.4], [uR0, top]);
    S.line(LAYER.outline, PEN.outline, [uR1, roof.top(strips.at(-1).s - roof.eaves.low) - 9.4], [uR1, top]);
    for (let i = 1; i < strips.length; i++) S.line(LAYER.outline, PEN.outline, [strips[i].a, Math.min(roof.top(strips[i - 1].s - roof.eaves.low), roof.top(strips[i].s - roof.eaves.low))], [strips[i].a, top]);
  } else {
    // high side: only the fascia band of the high eave is seen above the wall
    for (const f of F.faces) for (const [a, c] of f.visible) {
      const sE = roof.sOf(f.wall.a) + roof.eaves.high, yT = roof.top(sE), yF = roof.soffit(sE), wa = f === F.faces[0] && a === f.visible[0][0] ? uR0 : a, wc = c;
      S.line(LAYER.outline, PEN.outline, [wa, yT], [wc, yT]);
      S.line(LAYER.outline, PEN.fasciaMid, [wa, yT - 9.4], [wc, yT - 9.4]);
      S.line(LAYER.outline, PEN.outline, [wa, yF], [wc, yF]);
      S.solid(LAYER.fill, [[a, roof.soffit(sE - roof.eaves.high + 185)], [c, roof.soffit(sE - roof.eaves.high + 185)], [c, yF], [a, yF]], fillRgb.soffit);
    }
    const yT = roof.maxHeight;
    S.line(LAYER.outline, PEN.outline, [uR0, yT], [uR1, yT]);
    for (const u of [uR0, uR1]) S.line(LAYER.outline, PEN.outline, [u, roof.soffit(roof.sMax)], [u, yT]);
  }
  // ---- 土台 / 桁 members at the corner columns (1:2, hidden-member pen)
  for (const fi of info.faces) for (const uc of [fi.u0 + 185, fi.u1 - 185]) {
    S.rect(LAYER.member, PEN.member, uc - 52.5, L.foundationTop, uc + 52.5, L.sillTop); S.line(LAYER.member, PEN.member, [uc - 52.5, L.sillTop], [uc + 52.5, L.foundationTop]);
    const bt = profile ? roof.beamTopAt(sOfU(uc)) : roof.beamTopAt(roof.sOf(F.faces[0].wall.a));
    if (!profile) { S.rect(LAYER.member, PEN.member, uc - 52.5, bt - 180, uc + 52.5, bt); S.line(LAYER.member, PEN.member, [uc - 52.5, bt], [uc + 52.5, bt - 180]); }
  }
  return { S, uR0, uR1, info, profile, isLow };
}

/** Level lines, marks, level dimension chains, ground, title, grid bubbles and top dimensions. */
function annotateView(B, side, v, chainSide) {
  const { S, uR0, uR1, info } = v, { levels: L, roof, facades } = B, F = facades[side], M = MEASURED, C = M.chain;
  const sg = chainSide;                                  // -1: chains on the left, +1: on the right
  const edge = sg < 0 ? uR0 : uR1, far = sg < 0 ? uR1 : uR0, at = d => edge + sg * d;
  const xLabel = at(C.labelStart), xSolid = at(C.solidEnd), xFar = far - sg * C.chainBeyond;
  const top = roof.maxLabel, levelsDrawn = [['最高の高さ', top], ['軒桁上端', L.eave], ['1FL', L.FL], ['設計GL', 0]];
  // ground: GL line + band
  S.solid(LAYER.fill, [[xLabel, -M.groundBand[1]], [xLabel, -M.groundBand[0]], [xFar, -M.groundBand[0]], [xFar, -M.groundBand[1]]], fillRgb.ground);
  S.line(LAYER.outline, PEN.ground, [xLabel, 0], [xFar, 0]);
  for (const [name, y] of levelsDrawn) {
    if (y > 0) { S.line(LAYER.level, PEN.level, [xLabel, y], [xSolid, y]); S.line(LAYER.level, PEN.levelChain, [xSolid, y], [xFar, y]); }
    const xm = at(C.mark);
    if (y === 0) S.solid(LAYER.fill, [[xm, 0], [xm - 100, 200], [xm + 100, 200], [xm + 100, 200]], fillRgb.black);
    else S.poly(LAYER.text, PEN.mark, [[xm, y], [xm - 100, y + 200], [xm + 100, y + 200]], true);
    S.atext(LAYER.text, [xm + sg * 250, y + 10], name, TEXT.label, { ax: sg < 0 ? 1 : 0, ay: 0 });
    info.levels[name] = y;
  }
  // level chains: overall / FL-eave-top / structure / floor / ceiling
  const col = k => at(C.cols[k]);
  const chain = (x, vals, layer, pen, at = 0.5) => {
    S.line(layer, pen, [x, vals[0]], [x, vals.at(-1)]);
    for (const y of vals) S.point(layer, [x, y]);
    let flip = false;
    for (let i = 1; i < vals.length; i++) {
      const short = vals[i] - vals[i - 1] < 300; flip = short ? !flip : false;   // short spans alternate to the other side of the line
      S.atext(layer, [flip ? x + 10 : x - 10, vals[i - 1] + (vals[i] - vals[i - 1]) * at], fmt(vals[i] - vals[i - 1]), TEXT.dim, { angle: 90, ax: 0.5, ay: flip ? 0 : 1 });
    }
    return vals;
  };
  info.chains = {
    overall: chain(col(0), [0, top], LAYER.level, PEN.dimTop, 0.42),
    main: chain(col(1), [0, L.FL, L.eave, top], LAYER.level, PEN.dimTop),
    structure: chain(col(2), [0, L.foundationTop, L.sillTop, L.beamBottom, L.eave], LAYER.dim, PEN.dim),
    floor: chain(col(3), [L.sillTop, L.FL], LAYER.dim, PEN.dim),
    ceiling: chain(col(4), [L.FL, L.ceiling], LAYER.dim, PEN.dim)
  };
  for (const [y, x0] of [[L.foundationTop, col(2)], [L.sillTop, col(2)], [L.beamBottom, col(2)], [L.eave, col(2)], [L.ceiling, col(4)]]) S.line(LAYER.dim, PEN.dim, [x0, y], [xSolid, y]);
  S.atext(LAYER.dim, [sg < 0 ? col(2) + 260 : col(2) - 560, (L.sillTop + L.beamBottom) / 2], '横架材間距離', 0, { angle: 90, size: VLABEL });
  S.atext(LAYER.dim, [sg < 0 ? col(4) + 290 : col(4) - 560, (L.FL + L.ceiling) / 2], '天井高', 0, { angle: 90, size: VLABEL });
  S.atext(LAYER.dim, [col(2) - sg * 80, L.eave + 30], `軒高${fmt(L.eave)}`, TEXT.label, { ax: sg < 0 ? 0 : 1, ay: 0 });
  S.atext(LAYER.dim, [col(4) + sg * 90, L.foundationTop - 90], '基礎上端', 0, { ax: sg < 0 ? 0 : 1, ay: 0.5, size: SMALL });
  S.atext(LAYER.dim, [col(4) + sg * 90, L.sillTop + 140], '土台上端', 0, { ax: sg < 0 ? 0 : 1, ay: 0.5, size: SMALL });
  // top: grid bubbles (corners + interior walls meeting this facade) and two dimension tiers
  const g = B.spec.grid, gx = new Map(g.x.map((x, i) => [x, g.xLabels[i]])), gy = new Map(g.y.map((y, i) => [y, g.yLabels[i]]));
  const pts = new Set();
  for (const f of F.faces) {
    pts.add(F.u(f.wall.a)); pts.add(F.u(f.wall.b));
    for (const w of B.model.walls.filter(x => x.kind === 'int')) for (const p of [w.a, w.b]) if (Math.abs((p[0] - f.wall.a[0]) * f.wall.frame.n[0] + (p[1] - f.wall.a[1]) * f.wall.frame.n[1]) < 1 && F.u(p) > f.u0 - 1 && F.u(p) < f.u1 + 1) pts.add(F.u(p));
  }
  const us = [...pts].map(u => Math.round(u * 10) / 10).sort((p, q) => p - q).filter((u, i, a) => !i || u - a[i - 1] > 1);
  const labelOf = u => { const w = [F.uDir[0] * u, F.uDir[1] * u], k = F.uDir[0] ? w[0] : w[1]; return (F.uDir[0] ? gx : gy).get(Math.round(k * 10) / 10) ?? null; };
  const yT1 = roof.maxHeight + M.tierAboveTop, yT2 = yT1 + M.tierGap, yB = yT2 + M.bubbleAbove, extTop = roof.maxHeight + M.extTop;
  const tier = (vals, y, pen) => {
    S.line(LAYER.dim, pen, [vals[0], y], [vals.at(-1), y]);
    for (const u of vals) S.point(LAYER.dim, [u, y]);
    for (let i = 1; i < vals.length; i++) S.atext(LAYER.dim, [(vals[i] + vals[i - 1]) / 2, y + 10], fmt(vals[i] - vals[i - 1]), TEXT.dim, { ax: 0.5, ay: 0 });
  };
  const t1 = [uR0, ...us, uR1].sort((p, q) => p - q), t2 = [us[0], us.at(-1)];
  tier(t1, yT1, PEN.dimTop); tier(t2, yT2, PEN.dimTop);
  for (const u of t1) S.line(LAYER.dim, (u === uR0 || u === uR1) ? PEN.eaveDim : PEN.dim, [u, (u === uR0 || u === uR1) ? yT1 : yT2], [u, extTop]);
  info.tiers = [t1, t2];
  info.bubbles = [];
  for (const u of us) {
    const lab = labelOf(u);
    if (!lab) continue;
    S.line(LAYER.text, PEN.gridStub, [u, yT2], [u, yB - M.bubbleR]);
    S.arc(LAYER.text, PEN.bubble, [u, yB], M.bubbleR);
    S.atext(LAYER.text, [u, yB], lab, 0, { ax: 0.5, ay: 0.5, size: bubbleText(lab) });
    info.bubbles.push({ u, label: lab });
  }
  // title box under the building
  const cx = (uR0 + uR1) / 2, yt = -M.titleGap;
  const r = S.atext(LAYER.text, [cx, yt - M.titleBoxH / 2], F.name, TEXT.title, { ax: 0.5, ay: 0.5 });
  S.rect(LAYER.text, PEN.thin, r.x1 - 69, yt - M.titleBoxH, r.x2 + 69, yt);
  info.title = F.name;
}

/**
 * Draw the 4 elevations. Returns { bytes, doc, views, layout, warnings, building }.
 */
export function drawElevations(input, { building: prebuilt } = {}) {
  const B = prebuilt ?? buildBuilding(input), warnings = [];
  const cells = [['E', 0, -1], ['S', 1, 1], ['W', 2, -1], ['N', 3, 1]];
  const views = {};
  for (const [side, , cs] of cells) { const v = drawView(B, side, cs); annotateView(B, side, v, cs); views[side] = v; }
  // layout: columns sized to their widest view, rows at fixed GL lines (paper mm)
  const bb = Object.fromEntries(Object.entries(views).map(([k, v]) => [k, v.S.bbox()]));
  const wL = Math.max(bb.E[2] - bb.E[0], bb.W[2] - bb.W[0]) / SCALE, wR = Math.max(bb.S[2] - bb.S[0], bb.N[2] - bb.N[0]) / SCALE;
  const [ax1, ay1, ax2, ay2] = PAPER.area, gap = Math.max(4, (ax2 - ax1 - wL - wR) / 3);
  if (wL + wR > ax2 - ax1) warnings.push(`elevations ${Math.round(wL + wR)} mm wide exceed the A3 drawing area at 1/${SCALE}`);
  const hTop = Math.max(bb.E[3], bb.S[3]) / SCALE, hBot = Math.max(-bb.E[1], -bb.S[1], -bb.W[1], -bb.N[1]) / SCALE, rowH = (ay2 - ay1) / 2;
  const glTop = ay2 - 3 - hTop, glBot = glTop - rowH - 2;
  if (glBot - hBot < ay1 || Math.max(bb.W[3], bb.N[3]) / SCALE + glBot > glTop - hBot) warnings.push('elevation rows overlap vertically');
  const colX = { L: ax1 + gap, R: ax1 + gap * 2 + wL };
  const placement = { E: ['L', glTop], S: ['R', glTop], W: ['L', glBot], N: ['R', glBot] };
  const doc = newSheetDocument('elevation', { 1: { name: '立面図', scale: SCALE } }, 'fresco set-generator elevation scale=100');
  const layout = {};
  for (const [side, [c, gl]] of Object.entries(placement)) {
    const v = views[side], w = (c === 'L' ? wL : wR) * SCALE, x0 = colX[c] * SCALE + (w - (bb[side][2] - bb[side][0])) / 2 - bb[side][0];
    const d = [Math.round(x0 / 10) * 10, Math.round(gl * SCALE / 10) * 10];
    v.S.translate(d);
    layout[side] = { offset: d, bbox: v.S.bbox() };
    emit(doc, v.S);
  }
  emit(doc, drawFrame(styleTable('elevation'), { ...B.spec.title, drawing: '立面図', scale: '1/100', sheet: sheetNo(B.spec.title.sheet, 'A-11') }));
  const bytes = finish(doc);
  return { bytes, doc, views: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, v.info])), layout, warnings: [...B.warnings, ...warnings], building: B };
}
export const bubbleText = lab => { const n = [...lab].reduce((s, ch) => s + (ch.charCodeAt(0) < 128 ? 0.5 : 1), 0); return { h: 3.2, w: Math.min(3.2, 3.9 / Math.max(n, 1)) }; };
export const sheetNo = (base, fallback) => fallback;
export { ceil5, onModule };
