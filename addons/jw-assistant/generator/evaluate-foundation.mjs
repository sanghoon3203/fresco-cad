// evaluateFoundationPlan(bytes, spec, rules) and evaluateFoundationDetails(bytes, spec, rules).
// The plan origin is recovered from the grid bubbles; risers are checked under every bearing wall by reading the
// riser face lines (±riser/2) back, anchors / posts / manholes from their symbols, plus 建築士 checks
// (人通口 not under bearing walls, every void compartment reachable, anchor spacing and column-end rules).
import { buildBuilding, distToSeg } from './building.mjs';
import { onModule } from './spec.mjs';
import { readSheet, Checks, layerAndPenChecks, uniqMsgs, textSizeCheck, fitsSheetCheck, dimensionChainCheck, horizontals, verticals, near, hasText } from './evaluate-common.mjs';
import { round, pointOnSegment } from './geometry.mjs';

const WEIGHTS = { 'layer-role-purity': 2, 'pen-per-layer': 2, 'text-style-sizes': 1, 'fits-sheet': 2, 'origin-found': 3, 'risers-under-bearing-walls': 3, 'perimeter-insulation': 2,
  'dimension-sum-equals-overall': 3, 'grid-bubbles': 1, 'foundation-module': 3, 'anchors-at-column-ends': 3, 'anchor-spacing': 3, 'anchors-on-risers': 2, 'posts-on-grid': 2, 'slab-labels': 1,
  'manholes-not-under-walls': 2, 'void-compartments-reachable': 3, 'inspection-opening': 1, 'post-spacing': 1, 'interior-walls-supported': 1 };
const PLANNING = new Set(['manholes-not-under-walls', 'void-compartments-reachable', 'inspection-opening', 'post-spacing', 'interior-walls-supported']);

export function evaluateFoundationPlan(bytes, spec, rules = {}) {
  const B = buildBuilding(spec), R = rules.evaluation ?? {}, C = new Checks(WEIGHTS, PLANNING), { items, frame } = readSheet(bytes);
  const { model, foundation: FD, building: b } = B, F = b.foundation;
  const lp = layerAndPenChecks(items, R.pens ?? {});
  C.add('layer-role-purity', items.length, lp.purity.length, 'error', uniqMsgs(lp.purity));
  C.add('pen-per-layer', items.length, lp.pens.length, 'warn', uniqMsgs(lp.pens));
  const ts = textSizeCheck(items, R.textHeights ?? [2.5, 3.2, 3.5, 4]); C.add('text-style-sizes', ts.total, ts.bad.length, 'warn', ts.bad);
  const fs = fitsSheetCheck(items, frame); C.add('fits-sheet', fs.total, fs.bad.length, 'error', fs.bad);
  // origin from grid bubbles (1:A labels)
  const g = model.spec.grid, bx = [], by = [];
  for (const t of items.filter(i => i.kind === 'text' && i.layer === '1:A')) {
    const c = [(t.box.x1 + t.box.x2) / 2, (t.box.y1 + t.box.y2) / 2], kx = g.xLabels.indexOf(t.text), ky = g.yLabels.indexOf(t.text);
    if (kx >= 0) bx.push(c[0] - g.x[kx]); if (ky >= 0) by.push(c[1] - g.y[ky]);
  }
  const med = a => a.sort((p, q) => p - q)[a.length >> 1];
  if (!bx.length || !by.length) { C.add('origin-found', 1, 1, 'error', ['grid bubbles not found']); return C.result(); }
  C.add('origin-found', 1, 0, 'error');
  const o = [med(bx), med(by)], W = p => [p[0] + o[0], p[1] + o[1]];
  const h = F.riser / 2, risLines = items.filter(i => i.kind === 'line' && i.layer === '1:1' && i.color === 2), beamLines = items.filter(i => i.kind === 'line' && i.layer === '1:2');
  // a riser (beam) is under p when face lines run through p ± n·off on both sides
  const faceAt = (lines, p, dir, off) => [1, -1].every(s => lines.some(l => pointOnSegment([p[0] - dir[1] * off * s, p[1] + dir[0] * off * s], l.a, l.b, 1)));
  // risers (or grade beams) under every exterior wall and every interior (bearing) wall of the plan
  { const bad = []; let n = 0;
    const holes = FD.manholes.map(m => ({ ...m, a: [m.at[0] - m.dir[0] * m.width / 2, m.at[1] - m.dir[1] * m.width / 2], b: [m.at[0] + m.dir[0] * m.width / 2, m.at[1] + m.dir[1] * m.width / 2] }));
    const unsupported = [];
    for (const w of model.walls) {
      const d = w.frame.t, L = w.frame.length;
      for (let t = 300; t < L - 299; t += 455) {
        const p = [w.a[0] + d[0] * t, w.a[1] + d[1] * t];
        if (holes.some(m => distToSeg(p, m.a, m.b) < h + 50)) continue;              // inside a 人通口 (judged by the planning check)
        if (model.openings.some(op => op.wall === w.id && distToSeg(p, op.jambs[0], op.jambs[1]) < 5) && w.kind === 'int') continue;   // door: no wall above
        n++;
        const ok = faceAt(risLines, W(p), d, h) || (F.interior === 'grade-beam' && w.kind === 'int' && faceAt(beamLines, W(p), d, F.gradeBeamWidth / 2));
        if (!ok && F.interior === 'grade-beam' && w.kind === 'int') { unsupported.push(`wall ${w.id} at ${p.map(v => round(v))}: carried by the floor framing (大引/鋼製束), no grade beam below`); n--; continue; }
        if (!ok) { bad.push(`wall ${w.id} at ${p.map(v => round(v))}: no riser${F.interior === 'grade-beam' ? '/grade beam' : ''} below`); }
      }
    }
    C.add('risers-under-bearing-walls', n, bad.length, 'error', bad.slice(0, 12));
    if (F.interior === 'grade-beam') { const walls = new Set(unsupported.map(s => s.split(' ')[1])); C.add('interior-walls-supported', model.walls.filter(w => w.kind === 'int').length, walls.size, 'warn', [...walls].map(id => `wall ${id}: carried by the floor framing only (no grade beam below) - check 大引/束 sizing`)); } }
  { const eps = items.filter(i => i.kind === 'line' && i.layer === '1:1' && i.color === 7), per = model.poly.length;
    C.add('perimeter-insulation', per, Math.max(0, per - eps.length), 'warn', eps.length >= per ? [] : ['EPS outline (pen 7) incomplete']); }
  const dc = dimensionChainCheck(items, ['1:E']); C.add('dimension-sum-equals-overall', dc.total, dc.bad.length, 'error', dc.bad);
  { const want = g.xLabels.length * 2 + g.yLabels.length * 2, got = items.filter(i => i.kind === 'text' && i.layer === '1:A').length; C.add('grid-bubbles', want, Math.max(0, want - got), 'warn', got >= want ? [] : [`${got}/${want} bubbles`]); }
  { const bad = [];
    for (const r of FD.risers.concat(FD.beams)) for (const p of [r.a, r.b]) if (!onModule(p[0], g.x[0]) || !onModule(p[1], g.y[0])) bad.push(`foundation line end ${p} off the 455 module`);
    for (const m of FD.manholes) { const s = m.dir[0] ? m.at[0] : m.at[1]; if (!onModule(s - m.width / 2 + m.width / 2, 0) && !onModule(s, 0)) bad.push(`人通口 centre ${round(s)} off the 455 lattice`); }
    C.add('foundation-module', FD.risers.length + FD.beams.length + FD.manholes.length, bad.length, 'error', bad); }
  // anchors read back from 1:4 circles
  const anchors = items.filter(i => i.kind === 'arc' && i.layer === '1:4').map(a => [a.c[0] - o[0], a.c[1] - o[1]]);
  const risersAll = FD.risers;
  { const bad = [];
    const off = anchors.filter(p => !risersAll.some(r => distToSeg(p, r.a, r.b) < 2)); C.add('anchors-on-risers', anchors.length, off.length, 'error', off.map(p => `anchor at ${p.map(v => round(v))} off the riser centreline`));
    // column ends: every corner / junction / exterior jamb column needs an anchor within the end offset + tolerance on one of its risers
    const cols = model.columns.filter(c => c.why !== 'spacing' && risersAll.some(r => pointOnSegment(c.at, r.a, r.b, 1)));
    for (const c of cols) if (!anchors.some(p => Math.hypot(p[0] - c.at[0], p[1] - c.at[1]) <= F.anchor.endOffset + 120 && risersAll.some(r => pointOnSegment(p, r.a, r.b, 2) && pointOnSegment(c.at, r.a, r.b, 2))))
      bad.push(`column ${c.why} at ${c.at.map(v => round(v))}: no anchor within ${F.anchor.endOffset + 120}`);
    C.add('anchors-at-column-ends', cols.length, bad.length, 'error', bad);
    const gaps = [];
    for (const r of risersAll) {
      const L = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]), d = [(r.b[0] - r.a[0]) / L, (r.b[1] - r.a[1]) / L];
      const ts2 = anchors.filter(p => distToSeg(p, r.a, r.b) < 2).map(p => (p[0] - r.a[0]) * d[0] + (p[1] - r.a[1]) * d[1]).sort((p, q) => p - q);
      const ends = [0, ...ts2, L];
      for (let i = 1; i < ends.length; i++) if (ends[i] - ends[i - 1] > F.anchor.maxSpacing + 1) gaps.push(`riser ${r.a.map(v => round(v))}-${r.b.map(v => round(v))}: anchor gap ${round(ends[i] - ends[i - 1])} > ${F.anchor.maxSpacing}`);
    }
    C.add('anchor-spacing', risersAll.length, gaps.length, 'error', gaps); }
  // posts (1:3 circles) on the 910 grid, clear of risers
  { const posts = items.filter(i => i.kind === 'arc' && i.layer === '1:3').map(a => [a.c[0] - o[0], a.c[1] - o[1]]);
    const bad = posts.filter(p => !onModule(p[0], g.x[0]) || !onModule(p[1], g.y[0]) || risersAll.some(r => distToSeg(p, r.a, r.b) < F.riser / 2 + 50)).map(p => `post at ${p.map(v => round(v))} off-grid or on a riser`);
    C.add('posts-on-grid', posts.length, bad.length, 'error', bad);
    // every void compartment >= 1.5 m² gets posts no farther than pitch*sqrt(2) apart from a neighbour
    const lonely = posts.filter(p => posts.length > 1 && !posts.some(q => q !== p && Math.hypot(q[0] - p[0], q[1] - p[1]) <= F.postPitch * 1.5 + 1));
    C.add('post-spacing', posts.length, lonely.length, 'warn', lonely.map(p => `post at ${p.map(v => round(v))} has no neighbour within ${F.postPitch * 1.5}`)); }
  { const want = FD.comps.filter(c => !c.doma && c.area >= 1.5e6 && FD.compAt(c.center) === c.id).length, got = items.filter(t => t.kind === 'text' && /^耐圧版\d+t$/u.test(t.text)).length;
    C.add('slab-labels', want, Math.max(0, want - got), 'warn', got >= want ? [] : [`${got}/${want} slab labels`]); }
  // planning
  { const bad = [];
    for (const m of FD.manholes) {
      const underWall = model.walls.filter(w => w.kind === 'int' && pointOnSegment(m.at, w.a, w.b, 1));
      const underDoor = model.openings.some(op => op.wallKind === 'int' && distToSeg(m.at, op.jambs[0], op.jambs[1]) < 5 && Math.hypot(op.at[0] - m.at[0], op.at[1] - m.at[1]) < (op.width - m.width) / 2 + 1);
      if (underWall.length && !underDoor) bad.push(`人通口 at ${m.at.map(v => round(v))} under bearing wall ${underWall[0].id} (needs 補強: lintel / double sill)`);
      if (model.columns.some(c => Math.hypot(c.at[0] - m.at[0], c.at[1] - m.at[1]) < m.width / 2 + 52.5 + 100)) bad.push(`人通口 at ${m.at.map(v => round(v))} too close to a column`);
    }
    C.add('manholes-not-under-walls', Math.max(1, FD.manholes.length), bad.length, 'warn', bad);
    const voids = FD.comps.filter(c => !c.doma), seen = new Set([FD.inspect]);
    for (let k = 0; k < voids.length; k++) for (const m of FD.manholes) {
      const n = [-m.dir[1], m.dir[0]], A = FD.compAt([m.at[0] + n[0] * 200, m.at[1] + n[1] * 200]), Bc = FD.compAt([m.at[0] - n[0] * 200, m.at[1] - n[1] * 200]);
      if (seen.has(A) || seen.has(Bc)) { seen.add(A); seen.add(Bc); }
    }
    const cut = voids.filter(c => !seen.has(c.id));
    C.add('void-compartments-reachable', voids.length, cut.length, 'error', cut.map(c => `floor-void compartment at ${c.center.map(v => round(v))} (${round(c.area / 1e6, 100)} m²) not reachable from the inspection opening`));
    C.add('inspection-opening', 1, hasText(items, '床下点検口') ? 0 : 1, 'warn', hasText(items, '床下点検口') ? [] : ['床下点検口 not shown']); }
  return C.result({ origin: o.map(v => round(v, 10)), counts: { anchors: anchors.length, manholes: FD.manholes.length, posts: FD.posts.length, risers: FD.risers.length, beams: FD.beams.length } });
}

const DW = { 'layer-role-purity': 2, 'pen-per-layer': 1, 'text-style-sizes': 1, 'fits-sheet': 2, 'panels-present': 3, 'dimension-sum-equals-overall': 3, 'section-dimensions-match': 3, 'rebar-notes': 2, 'foundation-minimums': 3 };
export function evaluateFoundationDetails(bytes, spec, rules = {}) {
  const B = buildBuilding(spec), R = rules.evaluation ?? {}, C = new Checks(DW, new Set(['foundation-minimums'])), { items, frame } = readSheet(bytes), F = B.building.foundation, L = B.levels;
  const lp = layerAndPenChecks(items, R.detailPens ?? {});
  C.add('layer-role-purity', items.length, lp.purity.length, 'error', uniqMsgs(lp.purity));
  C.add('pen-per-layer', items.length, lp.pens.length, 'warn', uniqMsgs(lp.pens));
  const ts = textSizeCheck(items, R.detailTextHeights ?? [2.8, 3.2, 4]); C.add('text-style-sizes', ts.total, ts.bad.length, 'warn', ts.bad);
  const fs = fitsSheetCheck(items, frame); C.add('fits-sheet', fs.total, fs.bad.length, 'error', fs.bad);
  const titles = [/外周部/u, F.interior === 'grade-beam' ? /地中梁/u : /内部立上り/u, /人通口詳細図/u, /基礎仕様/u], miss = titles.filter(re => !hasText(items, re));
  C.add('panels-present', titles.length, miss.length, 'error', miss.map(re => `panel ${re.source} missing`));
  const dc = dimensionChainCheck(items, ['1:E']); C.add('dimension-sum-equals-overall', dc.total, dc.bad.length, 'error', dc.bad);
  const want = [F.riser, F.footingWidth, F.footingThickness, F.slab, F.footingBottom, L.foundationTop, F.footingBottom + L.foundationTop, F.manholeWidth].map(v => v.toLocaleString('en-US'));
  const bad = want.filter(v => !hasText(items, v, '1:E')); C.add('section-dimensions-match', want.length, bad.length, 'error', bad.map(v => `dimension ${v} missing`));
  const notes = [/D13/u, /D10@200/u, /EPS 厚/u, new RegExp(`耐圧版 厚${F.slab}`, 'u'), new RegExp(`アンカーボルト ${F.anchor.size}`, 'u')], nb = notes.filter(re => !hasText(items, re));
  C.add('rebar-notes', notes.length, nb.length, 'warn', nb.map(re => `note ${re.source} missing`));
  const P = R.planning ?? {}, mins = [];
  if (F.riser < (P.minRiserWidth ?? 120)) mins.push(`riser ${F.riser} < ${P.minRiserWidth ?? 120}`);
  if (F.slab < (P.minSlab ?? 150)) mins.push(`slab ${F.slab} < ${P.minSlab ?? 150}`);
  if (L.foundationTop < (P.minRiserAboveGL ?? 300)) mins.push(`riser top GL+${L.foundationTop} < ${P.minRiserAboveGL ?? 300}`);
  if (F.footingBottom < (P.minEmbed ?? 240)) mins.push(`embedment ${F.footingBottom} < ${P.minEmbed ?? 240}`);
  C.add('foundation-minimums', 4, mins.length, 'error', mins);
  return C.result();
}
export { horizontals, verticals };
