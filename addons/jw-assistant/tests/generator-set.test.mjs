import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeJww, encodeJww } from '../native/codec/jww-codec.mjs';
import { buildBuilding, levelsOf, openingHeights, BUILDING_DEFAULTS } from '../generator/building.mjs';
import { drawElevations } from '../generator/draw-elevation.mjs';
import { drawSection } from '../generator/draw-section.mjs';
import { drawFoundationPlan, drawFoundationDetails } from '../generator/draw-foundation.mjs';
import { evaluateElevations } from '../generator/evaluate-elevation.mjs';
import { evaluateSection } from '../generator/evaluate-section.mjs';
import { evaluateFoundationPlan, evaluateFoundationDetails } from '../generator/evaluate-foundation.mjs';
import { loadSetRules, readSheet } from '../generator/evaluate-common.mjs';

// 5,460 x 3,640 one-room house + wet core, entrance on the north, shed roof falling south.
const small = (building = {}) => ({
  name: 'set-small', title: { project: 'テスト', sheet: 'T-01', date: '2026-10-02' },
  grid: { x: { pitch: 910, count: 7 }, y: { pitch: 910, count: 5 } },
  exterior: [[0, 0], [5460, 0], [5460, 3640], [0, 3640]],
  walls: [{ id: 'p', from: [3640, 0], to: [3640, 3640] }, { id: 'q', from: [3640, 1820], to: [5460, 1820] }],
  openings: [
    { id: 'W1', type: 'window-sliding', at: [1820, 0], width: 1820, height: 2000 },
    { id: 'W2', type: 'window-sliding', at: [0, 1820], width: 1365, height: 1100 },
    { id: 'D1', type: 'entrance-door', at: [1365, 3640], width: 910, swing: 'N', hinge: 'start' },
    { id: 'D2', type: 'door-swing', at: [3640, 910], width: 910, swing: 'W', hinge: 'start' },
    { id: 'D3', type: 'door-swing', at: [3640, 2730], width: 910, swing: 'W', hinge: 'start' }
  ],
  rooms: [{ name: 'LDK', at: [1800, 1500] }, { name: '洋室', at: [4550, 900], kind: 'bedroom' }, { name: '洗面所', at: [4550, 2700], kind: 'wet' }],
  building
});
const rules = await loadSetRules();
const byId = (r, id) => r.checks.find(c => c.id === id);
const roundTrip = bytes => assert.equal(Buffer.compare(Buffer.from(encodeJww(decodeJww(bytes))), Buffer.from(bytes)), 0, 'codec re-encode must be byte identical');

test('building: measured office levels and shed roof geometry (house A numbers)', () => {
  const L = levelsOf(BUILDING_DEFAULTS);
  assert.deepEqual([L.foundationTop, L.sillTop, L.FL, L.beamBottom, L.eave, L.ceiling], [400, 505, 545, 3225, 3405, 2975]);
  const house = JSON.parse(JSON.stringify({ ...small(), exterior: [[0, 0], [10920, 0], [10920, 8190], [0, 8190]], walls: [], openings: [], rooms: [], grid: { x: { pitch: 910, count: 13 }, y: { pitch: 910, count: 10 } } }));
  const B = buildBuilding(house);
  assert.ok(Math.abs(B.roof.maxHeight - 6452.877) < 0.01, `max ${B.roof.maxHeight}`);
  assert.equal(B.roof.maxLabel, 6455);                                     // labelled rounded up to 5 mm
  assert.ok(Math.abs(B.roof.beamTopAt(8190) - 6271.5) < 0.01);             // high-side beam top measured in the section
  assert.equal(B.roof.low, 'S');
});

test('building: opening heights hang from the 2,000 head; tall sashes become full height', () => {
  const B = buildBuilding(small());
  const h = id => openingHeights(B.model.openings.find(o => o.id === id), B.building);
  assert.deepEqual(h('W1'), { sill: 0, head: 2000 });
  assert.deepEqual(h('W2'), { sill: 900, head: 2000 });
  assert.equal(h('D1').head, BUILDING_DEFAULTS.openings.entranceHead);
});

test('building: foundation risers, 人通口 linking every void, anchors <= 2,730 and at column ends, posts on 910', () => {
  const B = buildBuilding(small()), F = B.foundation;
  assert.equal(F.risers.filter(r => r.kind === 'ext').length, 4);
  assert.ok(F.risers.some(r => r.kind === 'int'));
  assert.ok(F.manholes.length >= 1 && F.manholes.every(m => m.width === 600));
  assert.ok(F.manholes.some(m => m.why === 'under-door'), 'prefers a doorway (no bearing wall above)');
  for (const r of F.risers) {
    const L = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]), ts = F.anchors.filter(a => a.riser === r).map(a => a.t).sort((p, q) => p - q), ends = [0, ...ts, L];
    for (let i = 1; i < ends.length; i++) assert.ok(ends[i] - ends[i - 1] <= 2731, `gap ${ends[i] - ends[i - 1]}`);
  }
  assert.ok(F.posts.every(p => p[0] % 910 === 0 && p[1] % 910 === 0));
  const gb = buildBuilding(small({ foundation: { interior: 'grade-beam' } })).foundation;
  assert.equal(gb.risers.filter(r => r.kind === 'int').length, 0);
  assert.ok(gb.beams.length >= 1 && gb.manholes.length === 0);
});

test('elevations: 4 views from the plan, openings / levels / roof match, codec round trip, score 100', async () => {
  const spec = small(), r = drawElevations(spec);
  roundTrip(r.bytes);
  assert.deepEqual(Object.keys(r.views).sort(), ['E', 'N', 'S', 'W']);
  assert.equal(r.views.S.openings.length, 1);                              // W1 on the south wall
  const e = evaluateElevations(r.bytes, spec, rules.elevation);
  for (const id of ['views-present', 'openings-match-plan', 'level-lines-match-building', 'level-chains-sum', 'roof-slope', 'roof-drains-to-low-side', 'dimension-sum-equals-overall', 'layer-role-purity', 'pen-per-layer'])
    assert.equal(byId(e, id).ratio, 1, `${id}: ${JSON.stringify(byId(e, id).details)}`);
  assert.equal(e.score, 100, JSON.stringify(e.findings));
  const texts = readSheet(r.bytes).items.filter(i => i.kind === 'text').map(i => i.text);
  for (const t of ['東立面図', '南立面図', '西立面図', '北立面図', '最高の高さ', '軒高3,405', '545', '2,860', '2,720']) assert.ok(texts.includes(t), t);
});

test('elevations: x-axis slope (low W) and drainage check catches a mirrored roof', () => {
  const spec = small({ roof: { low: 'W' } }), r = drawElevations(spec), e = evaluateElevations(r.bytes, spec, rules.elevation);
  assert.equal(byId(e, 'roof-drains-to-low-side').ratio, 1);
  // evaluate the same drawing against a spec whose roof falls east: the drawn roof now drains to the wrong side
  const wrong = evaluateElevations(r.bytes, small({ roof: { low: 'E' } }), rules.elevation);
  assert.ok(byId(wrong, 'roof-drains-to-low-side').ratio < 1);
});

test('section: heights add up, wall assembly and foundation layers drawn, score 100', () => {
  const spec = small(), r = drawSection(spec);
  roundTrip(r.bytes);
  const e = evaluateSection(r.bytes, spec, rules.section);
  for (const id of ['heights-match-building', 'heights-add-up', 'wall-assembly', 'foundation-layers', 'roof-slope', 'level-labels', 'dimension-sum-equals-overall']) assert.equal(byId(e, id).ratio, 1, `${id}: ${JSON.stringify(byId(e, id).details)}`);
  assert.equal(e.score, 100, JSON.stringify(e.findings));
  // a raised ceiling breaks the drawn heights when evaluated against the old drawing
  const moved = evaluateSection(r.bytes, small({ levels: { ceiling: 2300 } }), rules.section);
  assert.ok(byId(moved, 'heights-match-building').ratio < 1);
});

test('foundation plan + details: risers under walls, anchors, posts, manholes reachable, codec round trip', () => {
  const spec = small(), r = drawFoundationPlan(spec);
  roundTrip(r.bytes);
  const e = evaluateFoundationPlan(r.bytes, spec, rules.foundation);
  for (const id of ['risers-under-bearing-walls', 'anchors-at-column-ends', 'anchor-spacing', 'anchors-on-risers', 'posts-on-grid', 'void-compartments-reachable', 'dimension-sum-equals-overall', 'foundation-module'])
    assert.equal(byId(e, id).ratio, 1, `${id}: ${JSON.stringify(byId(e, id).details)}`);
  assert.ok(e.score >= 95, JSON.stringify(e.findings));
  const d = drawFoundationDetails(spec);
  roundTrip(d.bytes);
  const ed = evaluateFoundationDetails(d.bytes, spec, rules.foundation);
  assert.equal(ed.score, 100, JSON.stringify(ed.findings));
});

test('rulebooks are privacy clean and carry the measured numbers', async () => {
  for (const n of ['elevation', 'section', 'foundation']) {
    const raw = await readFile(new URL(`../knowledge/office-drafting-rules-${n}.json`, import.meta.url), 'utf8');
    assert.ok(!/様邸|株式会社|商会|建築士|登録第|丁目/u.test(raw), `${n} rulebook leaks client / office identity data`);
    const j = JSON.parse(raw);
    assert.ok(j.measured && j.evaluation?.pens, n);
  }
  assert.equal(rules.elevation.measured.siding.pitchMm, 50.3);
  assert.equal(rules.foundation.measured.riser.width, 150);
});

test('house A example reproduces the practice conventions (grade beams, 片流れ south, 6,455)', async () => {
  const spec = JSON.parse(await readFile(new URL('../generator/examples/house-a-shell.json', import.meta.url), 'utf8'));
  const B = buildBuilding(spec);
  assert.equal(B.roof.maxLabel, 6455);
  assert.equal(B.building.foundation.interior, 'grade-beam');
  assert.equal(B.foundation.beams.length, 7);
  const e = evaluateFoundationPlan(drawFoundationPlan(spec, { building: B }).bytes, spec, rules.foundation);
  assert.equal(byId(e, 'risers-under-bearing-walls').ratio, 1);
});
