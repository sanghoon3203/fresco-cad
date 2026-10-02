// evaluateSection(bytes, spec, rules) -> {score, subscores, checks[], findings[]}
// GL is recovered from the 1:0 ground lines (pen 6) and the cut position from the grid bubbles; heights, wall
// assemblies, roof and build-ups are compared with the building model. Planning checks follow 告示1347 / 建築基準法
// minimums for wood floors and mat foundations plus office comfort rules.
import { buildBuilding } from './building.mjs';
import { readSheet, Checks, layerAndPenChecks, uniqMsgs, textSizeCheck, fitsSheetCheck, dimensionChainCheck, horizontals, verticals, near, hasText } from './evaluate-common.mjs';
import { round } from './geometry.mjs';

const WEIGHTS = { 'layer-role-purity': 2, 'pen-per-layer': 2, 'text-style-sizes': 1, 'fits-sheet': 2, 'gl-and-grid-found': 3, 'heights-match-building': 3, 'level-labels': 2,
  'dimension-sum-equals-overall': 3, 'heights-add-up': 3, 'wall-assembly': 3, 'foundation-layers': 3, 'roof-slope': 3, 'insulation-drawn': 2, 'build-up-callouts': 2, 'rooms-labelled': 1,
  'ceiling-height': 2, 'floor-height': 2, 'foundation-minimums': 3, 'head-clearance': 1 };
const PLANNING = new Set(['ceiling-height', 'floor-height', 'foundation-minimums', 'head-clearance']);

export function evaluateSection(bytes, spec, rules = {}) {
  const B = buildBuilding(spec), R = rules.evaluation ?? {}, C = new Checks(WEIGHTS, PLANNING), { items, frame } = readSheet(bytes);
  const { levels: L, roof, building: b, section: X } = B, F = b.foundation;
  const lp = layerAndPenChecks(items, R.pens ?? {});
  C.add('layer-role-purity', items.length, lp.purity.length, 'error', uniqMsgs(lp.purity));
  C.add('pen-per-layer', items.length, lp.pens.length, 'warn', uniqMsgs(lp.pens));
  const ts = textSizeCheck(items, R.textHeights ?? [2.5, 2.8, 3, 3.2, 4]); C.add('text-style-sizes', ts.total, ts.bad.length, 'warn', ts.bad);
  const fs = fitsSheetCheck(items, frame); C.add('fits-sheet', fs.total, fs.bad.length, 'error', fs.bad);
  // GL from 1:0 ground lines; u origin from the first grid bubble (label -> grid coordinate)
  const ground = horizontals(items, '1:0', 300).filter(l => l.color === 6), gy = ground[0]?.a[1];
  const g = B.spec.grid, vals = X.axis === 'y' ? g.y : g.x, labs = X.axis === 'y' ? g.yLabels : g.xLabels;
  const bub = items.filter(t => t.kind === 'text' && t.layer === '1:D' && labs.includes(t.text)).map(t => ({ v: vals[labs.indexOf(t.text)], x: (t.box.x1 + t.box.x2) / 2 }));
  const ox = bub.length ? bub.reduce((s, q) => s + (q.x - q.v), 0) / bub.length : null;
  const okFrame = gy !== undefined && ox !== null;
  C.add('gl-and-grid-found', 2, (gy === undefined) + (ox === null), 'error', [...(gy === undefined ? ['no GL ground line (1:0 pen 6)'] : []), ...(ox === null ? ['no grid bubbles'] : [])]);
  if (!okFrame) return C.result();
  const U = u => ox + u, H = h => gy + h;
  const hz = horizontals(items, null, 50), vt = verticals(items, null, 50);
  const hasH = (y, layer, tol = 1) => hz.some(l => (!layer || l.layer === layer) && near(l.a[1], H(y), tol));
  // heights drawn
  { const want = [['基礎天端', L.foundationTop], ['土台上端', L.sillTop], ['FL', L.FL], ['天井', L.ceiling], ['耐圧版天端', F.slabTop], ['耐圧版下端', F.slabTop - F.slab], ['土間下断熱下端', F.slabTop - F.slab - F.slabInsulation], ['フーチン上端', -F.footingBottom + F.footingThickness], ['フーチン下端', -F.footingBottom]];
    const bad = want.filter(([, y]) => !hasH(y, '1:1') && !hasH(y, '1:2')).map(([n, y]) => `${n} GL${y >= 0 ? '+' : ''}${y} not drawn`);
    C.add('heights-match-building', want.length, bad.length, 'error', bad); }
  { const want = [`最高の高さ GL+${roof.maxLabel.toLocaleString('en-US')}`, `軒高 GL+${L.eave.toLocaleString('en-US')}`, `1FL GL+${L.FL}`, '設計GL'];
    const bad = want.filter(t => !hasText(items, t)); C.add('level-labels', want.length, bad.length, 'error', bad.map(t => `level label "${t}" missing`)); }
  const dc = dimensionChainCheck(items, ['1:E']); C.add('dimension-sum-equals-overall', dc.total, dc.bad.length, 'error', dc.bad);
  { const bad = [], s = (a) => a.reduce((x, y) => x + y, 0);
    if (s([L.foundationTop, L.sillTop - L.foundationTop, L.beamBottom - L.sillTop, L.eave - L.beamBottom]) !== L.eave) bad.push('400+105+2720+180 != eave');
    if (s([L.FL, L.eave - L.FL, roof.maxLabel - L.eave]) !== roof.maxLabel) bad.push('FL + 2860 + roof != max');
    for (const v of [L.FL, L.eave - L.FL, roof.maxLabel - L.eave, L.beamBottom - L.sillTop, L.ceiling - L.FL, F.footingBottom]) if (!hasText(items, v.toLocaleString('en-US'), '1:E')) bad.push(`chain value ${v} missing`);
    C.add('heights-add-up', 8, bad.length, 'error', bad); }
  // exterior wall assemblies at each exterior crossing (siding -185, battens -152/-62, core ±52.5, interior +65)
  const along = X.axis === 'y' ? 1 : 0, across = 1 - along;
  const extWalls = B.model.walls.filter(w => w.kind === 'ext' && near(w.a[along], w.b[along], 0.5) && Math.min(w.a[across], w.b[across]) < X.at && Math.max(w.a[across], w.b[across]) > X.at);
  { const bad = []; let n = 0;
    for (const w of extWalls) {
      const o = -Math.sign(w.frame.n[along]);
      for (const v of [-185, -170, -152, -62, 52.5, -52.5, 65]) { n++; const x = U(w.a[along] + o * -v); if (!vt.some(l => near(l.a[0], x, 1) && Math.min(l.a[1], l.b[1]) < H(L.ceiling) && Math.max(l.a[1], l.b[1]) > H(L.FL + 100))) bad.push(`wall ${w.id}: line at v=${v} missing`); }
    }
    C.add('wall-assembly', n, bad.length, 'error', bad); }
  { const bad = []; let n = 0;
    for (const w of extWalls) {
      const o = -Math.sign(w.frame.n[along]), u = w.a[along];
      for (const [name, v] of [['riser out', F.riser / 2], ['riser in', -F.riser / 2], ['EPS', F.riser / 2 + F.edgeInsulation]]) { n++; if (!vt.some(l => near(l.a[0], U(u + o * v), 1) && near(Math.max(l.a[1], l.b[1]), H(L.foundationTop), 1))) bad.push(`wall ${w.id}: foundation ${name} line missing`); }
      n++; if (!hz.some(l => near(l.a[1], H(-F.footingBottom), 1) && near(Math.abs(l.a[0] - l.b[0]), F.footingWidth, 1))) bad.push(`wall ${w.id}: footing ${F.footingWidth} missing`);
    }
    C.add('foundation-layers', n, bad.length, 'error', bad); }
  // roof slope + top
  { const bad = [];
    const sl = items.filter(i => i.kind === 'line' && i.layer === '1:1' && i.color === 2).map(l => ({ l, dx: l.b[0] - l.a[0], dy: l.b[1] - l.a[1] })).filter(o => Math.abs(o.dx) > 2000).sort((p, q) => Math.abs(q.dx) - Math.abs(p.dx))[0];
    const want = X.axis === roof.axis ? roof.slope : 0;
    if (!sl) bad.push('no roof line');
    else {
      if (!near(Math.abs(sl.dy / sl.dx), want, 0.002)) bad.push(`roof slope ${round(Math.abs(sl.dy / sl.dx), 1000)} != ${want}`);
      const top = Math.max(sl.l.a[1], sl.l.b[1]) - gy;
      if (X.axis === roof.axis && !near(top, roof.maxHeight, 2)) bad.push(`roof top GL+${round(top, 10)} != ${round(roof.maxHeight, 10)}`);
    }
    C.add('roof-slope', 2, bad.length, 'error', bad); }
  { const n1A = items.filter(i => i.layer === '1:A').length, n1C = items.filter(i => i.layer === '1:C').length, bad = [];
    if (n1A < 50) bad.push('wall / ceiling / slab insulation (1:A) missing'); if (n1C < 10) bad.push('added insulation hatch (1:C) missing');
    C.add('insulation-drawn', 2, bad.length, 'error', bad); }
  { const all = [...b.buildUps.roof, ...b.buildUps.wall, ...b.buildUps.interior, ...b.buildUps.foundation], bad = all.filter(t => !hasText(items, `・${t}`, '1:D'));
    C.add('build-up-callouts', all.length, bad.length, 'warn', bad.map(t => `build-up "${t}" missing`)); }
  { const along2 = X.axis === 'y' ? 1 : 0, names = new Set();
    for (let u = Math.min(...B.model.poly.map(p => p[along2])) + 300; u < Math.max(...B.model.poly.map(p => p[along2])) - 300; u += 455) { const p = along2 ? [X.at, u] : [u, X.at]; const r = B.model.rooms.find(rm => rm.contains(p)); if (r) names.add(r.name); }
    const bad = [...names].filter(nm => !hasText(items, nm, '1:D')); C.add('rooms-labelled', names.size, bad.length, 'warn', bad.map(nm => `room ${nm} on the cut not labelled`)); }
  // planning
  const P = R.planning ?? {};
  C.add('ceiling-height', 1, L.ceiling - L.FL < (P.minCeiling ?? 2400) ? 1 : 0, 'warn', L.ceiling - L.FL < (P.minCeiling ?? 2400) ? [`ceiling ${L.ceiling - L.FL} < ${P.minCeiling ?? 2400}`] : []);
  C.add('floor-height', 1, L.FL < (P.minFloorHeight ?? 450) ? 1 : 0, 'error', L.FL < (P.minFloorHeight ?? 450) ? [`FL GL+${L.FL} < ${P.minFloorHeight ?? 450} (令22条)`] : []);
  { const bad = [];
    if (L.foundationTop < (P.minRiserAboveGL ?? 300)) bad.push(`riser top GL+${L.foundationTop} < ${P.minRiserAboveGL ?? 300}`);
    if (F.riser < (P.minRiserWidth ?? 120)) bad.push(`riser ${F.riser} < ${P.minRiserWidth ?? 120}`);
    if (F.slab < (P.minSlab ?? 150)) bad.push(`slab ${F.slab} < ${P.minSlab ?? 150}`);
    if (F.footingBottom < (P.minEmbed ?? 240)) bad.push(`embedment ${F.footingBottom} < ${P.minEmbed ?? 240}`);
    C.add('foundation-minimums', 4, bad.length, 'error', bad); }
  { const space = L.beamBottom - L.ceiling, bad = space < 100 ? [`only ${space} between ceiling and beam bottom`] : [];
    C.add('head-clearance', 1, bad.length, 'warn', bad); }
  return C.result({ gl: round(gy, 10), uOrigin: round(ox, 10) });
}
