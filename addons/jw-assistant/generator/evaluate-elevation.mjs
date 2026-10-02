// evaluateElevations(bytes, spec, rules) -> {score, subscores, checks[], findings[]}
// Each view is located from its title text (東/南/西/北立面図) and the GL line above it; expected geometry comes from
// the building model (plan openings on the facing walls, levels, roof). Drafting + 建築士 planning checks.
import { buildBuilding, openingHeights, SIDE_NAMES } from './building.mjs';
import { readSheet, Checks, layerAndPenChecks, uniqMsgs, textSizeCheck, fitsSheetCheck, dimensionChainCheck, horizontals, verticals, near } from './evaluate-common.mjs';
import { round } from './geometry.mjs';

const WEIGHTS = { 'layer-role-purity': 2, 'pen-per-layer': 2, 'text-style-sizes': 1, 'fits-sheet': 2, 'views-present': 3, 'level-lines-match-building': 3, 'level-chains-sum': 3,
  'dimension-sum-equals-overall': 3, 'openings-match-plan': 3, 'roof-slope': 3, 'roof-drains-to-low-side': 2, 'siding-pitch': 1, 'grid-bubbles': 1, 'top-tiers-sum': 2,
  'window-heads-aligned': 2, 'heads-below-lintel': 2, 'height-limit': 2, 'eaves-overhang': 1, 'entrance-not-under-drip': 1, 'roof-spans-short-side': 2 };
const PLANNING = new Set(['window-heads-aligned', 'heads-below-lintel', 'height-limit', 'eaves-overhang', 'entrance-not-under-drip', 'roof-spans-short-side']);

/** u-range of the roof silhouette for a view (left -> right as seen). */
export function roofExtentU(B, side) {
  const { roof, facades } = B, F = facades[side], profile = (roof.axis === 'y') === (side === 'E' || side === 'W');
  if (!profile) return [F.uMin - roof.eaves.gable, F.uMax + roof.eaves.gable];
  const axisVec = roof.axis === 'y' ? [0, 1] : [1, 0], ud = F.uDir[0] * axisVec[0] + F.uDir[1] * axisVec[1], uOfS = s => ud * (s * roof.sign + roof.s0);
  return [uOfS(roof.sMin), uOfS(roof.sMax)].sort((p, q) => p - q);
}

export function evaluateElevations(bytes, spec, rules = {}) {
  const B = buildBuilding(spec), R = rules.evaluation ?? {}, C = new Checks(WEIGHTS, PLANNING), { items, frame } = readSheet(bytes);
  const { levels: L, roof, building: b } = B;
  // ---- drafting: layers, pens, text sizes, sheet
  const lp = layerAndPenChecks(items, R.pens ?? {});
  C.add('layer-role-purity', items.length, lp.purity.length, 'error', uniqMsgs(lp.purity));
  C.add('pen-per-layer', items.length, lp.pens.length, 'warn', uniqMsgs(lp.pens));
  const ts = textSizeCheck(items, R.textHeights ?? [2.1, 2.3, 2.5, 3, 3.2, 4]);
  C.add('text-style-sizes', ts.total, ts.bad.length, 'warn', ts.bad);
  const fs = fitsSheetCheck(items, frame); C.add('fits-sheet', fs.total, fs.bad.length, 'error', fs.bad);
  // ---- locate views
  const views = {}, missing = [];
  const gls = horizontals(items, '1:1', 5000).filter(l => l.color === 2);
  for (const side of ['E', 'S', 'W', 'N']) {
    const t = items.find(i => i.kind === 'text' && i.text === SIDE_NAMES[side]);
    if (!t) { missing.push(side); continue; }
    const cx = (t.box.x1 + t.box.x2) / 2, top = t.box.y2;
    const gl = gls.filter(l => l.a[1] > top && Math.min(l.a[0], l.b[0]) < cx && Math.max(l.a[0], l.b[0]) > cx).sort((p, q) => p.a[1] - q.a[1])[0];
    if (!gl) { missing.push(side); continue; }
    const [u0, u1] = roofExtentU(B, side), x = u => cx + (u - (u0 + u1) / 2);
    views[side] = { cx, gy: gl.a[1], x, u0, u1, xl: Math.min(gl.a[0], gl.b[0]), xr: Math.max(gl.a[0], gl.b[0]) };
  }
  C.add('views-present', 4, missing.length, 'error', missing.map(s => `${SIDE_NAMES[s]} not found (title + GL line)`));
  const inView = (v, p) => p[0] >= v.xl - 1 && p[0] <= v.xr + 1 && p[1] >= v.gy - 2000 && p[1] <= v.gy + 14000;
  // ---- level lines (1:0) at FL / eave / max for each view
  { const bad = []; let n = 0;
    for (const [side, v] of Object.entries(views)) for (const [name, y] of [['1FL', L.FL], ['軒桁上端', L.eave], ['最高の高さ', roof.maxLabel]]) {
      n++; if (!horizontals(items, '1:0', 500).some(l => near(l.a[1] - v.gy, y, 1) && inView(v, l.a))) bad.push(`${SIDE_NAMES[side]}: no level line ${name} at GL+${y}`);
    }
    C.add('level-lines-match-building', n, bad.length, 'error', bad); }
  // ---- level chains: 545 + 2,860 + 3,050 = 6,455 and 400 + 105 + 2,720 + 180 = eave
  { const bad = []; let n = 0;
    const want = [[L.FL, L.eave - L.FL, roof.maxLabel - L.eave], [L.foundationTop, L.sillTop - L.foundationTop, L.beamBottom - L.sillTop, L.eave - L.beamBottom]];
    for (const [side, v] of Object.entries(views)) for (const chain of want) {
      n++;
      const found = chain.every(val => items.some(t => t.kind === 'text' && t.angle === 90 && t.text === val.toLocaleString('en-US') && inView(v, t.at)));
      if (!found) bad.push(`${SIDE_NAMES[side]}: chain ${chain.join(' + ')} incomplete`);
    }
    if (want[0].reduce((s, x) => s + x, 0) !== roof.maxLabel) bad.push('FL + eave + roof chain does not add up to the max height');
    C.add('level-chains-sum', n, bad.length, 'error', bad); }
  const dc = dimensionChainCheck(items, ['1:0', '1:E']);
  C.add('dimension-sum-equals-overall', dc.total, dc.bad.length, 'error', dc.bad);
  // ---- openings (outer frame rectangle on 1:5) match the plan openings on the facing walls
  const op15 = items.filter(i => i.layer === '1:5' && i.kind === 'line');
  const hasSeg = (a, b2) => op15.some(l => (near(l.a[0], a[0], 1.5) && near(l.a[1], a[1], 1.5) && near(l.b[0], b2[0], 1.5) && near(l.b[1], b2[1], 1.5)) || (near(l.b[0], a[0], 1.5) && near(l.b[1], a[1], 1.5) && near(l.a[0], b2[0], 1.5) && near(l.a[1], b2[1], 1.5)));
  { const bad = []; let n = 0;
    for (const [side, v] of Object.entries(views)) for (const op of B.facades[side].openings) {
      n++;
      const h = openingHeights(op.o, b), x0 = v.x(op.u0), x1 = v.x(op.u1), y0 = v.gy + L.FL + h.sill, y1 = v.gy + L.FL + h.head;
      const ok = hasSeg([x0, y0], [x1, y0]) && hasSeg([x0, y1], [x1, y1]) && hasSeg([x0, y0], [x0, y1]) && hasSeg([x1, y0], [x1, y1]);
      if (!ok) bad.push(`${SIDE_NAMES[side]}: opening ${op.o.id} (${round(op.u1 - op.u0)}x${h.head - h.sill}, sill FL+${h.sill}) not drawn at its plan position`);
    }
    C.add('openings-match-plan', n, bad.length, 'error', bad); }
  // ---- roof: slope line on profile views ends at the max height on the high side; drains to the low side
  { const bad = [], drain = []; let n = 0;
    for (const [side, v] of Object.entries(views)) {
      const profile = (roof.axis === 'y') === (side === 'E' || side === 'W');
      if (!profile) continue;
      n++;
      const sl = items.filter(i => i.kind === 'line' && i.layer === '1:1' && i.color === 6 && inView(v, i.a)).map(l => ({ l, dx: l.b[0] - l.a[0], dy: l.b[1] - l.a[1] })).filter(o => Math.abs(o.dx) > 3000 && Math.abs(o.dy) > 300).sort((p, q) => Math.abs(q.dx) - Math.abs(p.dx))[0];
      if (!sl) { bad.push(`${SIDE_NAMES[side]}: no roof slope line`); continue; }
      const slope = Math.abs(sl.dy / sl.dx), hi = sl.l.a[1] > sl.l.b[1] ? sl.l.a : sl.l.b, lo = hi === sl.l.a ? sl.l.b : sl.l.a;
      if (!near(slope, roof.slope, 0.002)) bad.push(`${SIDE_NAMES[side]}: roof slope ${round(slope, 1000)} != ${roof.slope}`);
      if (!near(hi[1] - v.gy, roof.maxHeight, 2)) bad.push(`${SIDE_NAMES[side]}: roof top GL+${round(hi[1] - v.gy, 10)} != ${round(roof.maxHeight, 10)}`);
      // low end must be on the low-eave side as seen in this view
      const lowWorldU = roofExtentU(B, side), lowU = (() => { const F = B.facades[side], p0 = [F.uDir[0] * lowWorldU[0], F.uDir[1] * lowWorldU[0]]; return roof.sOf(p0) < roof.sOf([F.uDir[0] * lowWorldU[1], F.uDir[1] * lowWorldU[1]]) ? 'left' : 'right'; })();
      if ((lo[0] < hi[0] ? 'left' : 'right') !== lowU) drain.push(`${SIDE_NAMES[side]}: roof falls toward the ${lo[0] < hi[0] ? 'left' : 'right'}, the plan low side is ${lowU}`);
      if (!items.some(t => t.layer === '1:9' && t.text === String(roof.slope * 10) && inView(v, t.at))) bad.push(`${SIDE_NAMES[side]}: slope mark ${roof.slope * 10}/10 missing`);
    }
    C.add('roof-slope', n, bad.length, 'error', bad);
    C.add('roof-drains-to-low-side', n, drain.length, 'error', drain); }
  // ---- siding pitch (縦張り 1:8)
  { const vs = verticals(items, '1:8', 200).map(l => ({ x: l.a[0], y0: Math.min(l.a[1], l.b[1]), y1: Math.max(l.a[1], l.b[1]) })).sort((p, q) => p.x - q.x), gaps = [];
    for (let i = 0; i < vs.length; i++) { const nx = vs.slice(i + 1, i + 40).find(w => w.x > vs[i].x + 1 && w.y0 < vs[i].y1 && w.y1 > vs[i].y0); if (nx && nx.x - vs[i].x < 200) gaps.push(nx.x - vs[i].x); }
    const med = gaps.sort((p, q) => p - q)[gaps.length >> 1] ?? 0, want = R.sidingPitch ?? 50.3;
    C.add('siding-pitch', 1, near(med, want, 1) ? 0 : 1, 'warn', near(med, want, 1) ? [] : [`siding pitch ${round(med, 10)} != ${want}`]); }
  // ---- grid bubbles: facade corner grid lines labelled in every view
  { const bad = []; let n = 0, g = B.spec.grid;
    for (const [side, v] of Object.entries(views)) {
      const F = B.facades[side];
      for (const u of [F.uMin, F.uMax]) {
        n++; const w = F.uDir[0] ? Math.abs(u) : Math.abs(u), k = F.uDir[0] !== 0 ? g.x.indexOf(Math.round(w * 10) / 10) : g.y.indexOf(Math.round(w * 10) / 10), lab = F.uDir[0] !== 0 ? g.xLabels[k] : g.yLabels[k];
        if (!lab || !items.some(t => t.kind === 'text' && t.layer === '1:D' && t.text === lab && near((t.box.x1 + t.box.x2) / 2, v.x(u), 60))) bad.push(`${SIDE_NAMES[side]}: grid bubble ${lab ?? u} missing`);
      }
    }
    C.add('grid-bubbles', n, bad.length, 'warn', bad); }
  // ---- top tiers: eaves + grid spans = roof width; grid overall = building width
  { const bad = []; let n = 0;
    for (const [side, v] of Object.entries(views)) {
      n++; const F = B.facades[side], want = (F.uMax - F.uMin).toLocaleString('en-US');
      if (!items.some(t => t.layer === '1:E' && t.text === want && inView(v, t.at))) bad.push(`${SIDE_NAMES[side]}: overall ${want} missing`);
    }
    C.add('top-tiers-sum', n, bad.length, 'warn', bad); }
  // ---- planning (建築士)
  { const heads = B.model.openings.filter(o => o.wallKind === 'ext' && o.type === 'window-sliding').map(o => ({ id: o.id, ...openingHeights(o, b) }));
    const std = heads.filter(h => h.sill > 0), odd = std.filter(h => h.head !== b.openings.head && !(b.openings.byId?.[h.id]?.head));
    C.add('window-heads-aligned', std.length, odd.length, 'warn', odd.map(h => `window ${h.id}: head FL+${h.head} off the standard FL+${b.openings.head}`));
    const lintel = L.beamBottom - L.FL - 105, high = heads.filter(h => h.head > lintel);
    C.add('heads-below-lintel', heads.length, high.length, 'error', high.map(h => `window ${h.id}: head FL+${h.head} cuts into the beam/lintel zone (max FL+${lintel})`));
    const limit = R.planning?.maxHeightMm ?? 10000;
    C.add('height-limit', 1, roof.maxHeight > limit ? 1 : 0, 'error', roof.maxHeight > limit ? [`max height ${round(roof.maxHeight)} > ${limit} (低層住居系の絶対高さ)`] : []);
    const e = b.roof.eaves, bad = [];
    if (e.low < (R.planning?.minLowEave ?? 450)) bad.push(`low eave ${e.low} < ${R.planning?.minLowEave ?? 450} (rain on the low wall)`);
    if (e.high < (R.planning?.minHighEave ?? 200)) bad.push(`high eave ${e.high} < ${R.planning?.minHighEave ?? 200}`);
    if (e.gable < (R.planning?.minGableEave ?? 300)) bad.push(`gable eave ${e.gable} < ${R.planning?.minGableEave ?? 300}`);
    C.add('eaves-overhang', 3, bad.length, 'warn', bad);
    const ent = B.model.openings.filter(o => o.type === 'entrance-door'), lowSide = roof.low, drip = ent.filter(o => B.facades[lowSide].openings.some(x => x.o.id === o.id) && !(b.openings.byId?.[o.id]?.canopy));
    { const d = a => { const v = B.model.poly.map(p => a === 'x' ? p[0] : p[1]); return Math.max(...v) - Math.min(...v); }, other = roof.axis === 'x' ? 'y' : 'x', rise = roof.maxHeight - L.eave, long = d(roof.axis) > d(other) + 1;
      const msg = long && rise > (R.planning?.maxShedRise ?? 3000) ? [`shed roof falls along the long side (${d(roof.axis)} > ${d(other)}): rise ${Math.round(rise)} - turn the slope across the short span`] : [];
      C.add('roof-spans-short-side', 1, msg.length, 'warn', msg); }
    C.add('entrance-not-under-drip', ent.length, drip.length, 'warn', drip.map(o => `entrance ${o.id} is under the low eave drip line (add a canopy/gutter or move it)`)); }
  return C.result({ views: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, { cx: round(v.cx, 10), gl: round(v.gy, 10) }])) });
}
