import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeJww, encodeJww, semanticView } from '../native/codec/jww-codec.mjs';
import { normalizeSpec, validateSpec, onModule, PLAN_SPEC_SCHEMA } from '../generator/spec.mjs';
import { buildModel, EXT } from '../generator/model.mjs';
import { drawPlan, SCALE } from '../generator/draw-plan.mjs';
import { evaluatePlan, loadRules } from '../generator/evaluate.mjs';
import { signedArea, offsetPolygon, normalizePolygon, gridBoundary, cellGrid, subtractIntervals, clipLineToRings } from '../generator/geometry.mjs';

// Small but complete plan: 4550 x 3640 box, one partition with a door, windows, wet room, entrance.
const tiny = () => ({
  name: 'tiny', grid: { x: { pitch: 910, count: 6 }, y: { pitch: 910, count: 5 } },
  exterior: [[0, 0], [4550, 0], [4550, 3640], [0, 3640]],
  walls: [{ id: 'p', from: [2730, 0], to: [2730, 3640] }],
  openings: [
    { id: 'W1', type: 'window-sliding', at: [1365, 0], width: 1820 },
    { id: 'W2', type: 'window-sliding', at: [3640, 0], width: 910 },
    { id: 'D1', type: 'door-swing', at: [2730, 2275], width: 910, swing: 'E', hinge: 'start' },
    { id: 'D2', type: 'entrance-door', at: [1365, 3640], width: 910, swing: 'N', hinge: 'start' }
  ],
  rooms: [{ name: 'LDK', at: [1365, 1500], kind: 'entrance', doma: [455, 2730, 2275, 3640] }, { name: '洋室', at: [3640, 1500], kind: 'other' }],
  items: [{ type: 'table-small', at: [1300, 1200] }]
});
const rules = await loadRules();
const byId = (r, id) => r.checks.find(c => c.id === id);

test('spec: normalisation, grid shorthand, schema and structural errors', () => {
  const { spec, errors } = normalizeSpec(tiny());
  assert.deepEqual(errors, []);
  assert.deepEqual(spec.grid.x, [0, 910, 1820, 2730, 3640, 4550]);
  assert.equal(spec.grid.xLabels[5], 'X6');
  assert.ok(PLAN_SPEC_SCHEMA.properties.openings.items.properties.type.enum.includes('door-sliding-double'));
  const bad = normalizeSpec({ ...tiny(), openings: [{ type: 'door-swing', at: [2730, 2275], width: 910 }], walls: [{ from: [0, 0], to: [10, 10] }] });
  assert.ok(bad.errors.some(e => /swing/u.test(e)) && bad.errors.some(e => /horizontal or vertical/u.test(e)));
  assert.ok(normalizeSpec({ ...tiny(), exterior: [[0, 0], [4550, 0], [3000, 3640], [0, 3640]] }).errors.some(e => /rectilinear/u.test(e)));
});

test('spec: 尺モジュール - off-grid structure is an error, off-module openings only a warning', () => {
  assert.ok(onModule(1365) && onModule(2047.5 - 682.5) && !onModule(1100));
  assert.ok(normalizeSpec({ ...tiny(), grid: { x: [0, 900, 1820], y: [0, 910] } }).errors.some(e => /multiple of 455/u.test(e)));
  assert.ok(normalizeSpec({ ...tiny(), exterior: [[0, 0], [4500, 0], [4500, 3640], [0, 3640]] }).errors.some(e => /off the 455 module/u.test(e)));
  const v = validateSpec({ ...tiny(), walls: [{ id: 'p', from: [2700, 0], to: [2700, 3640] }], openings: [] });
  assert.equal(v.ok, false); assert.ok(v.errors.some(e => /wall p: end .* off the 455 module/u.test(e)));
  const w = validateSpec({ ...tiny(), openings: [{ id: 'W9', type: 'window-sliding', at: [1365, 0], width: 1130 }] });
  assert.equal(w.ok, true); assert.ok(w.warnings.some(x => /W9: jamb columns/u.test(x)));
});

test('model: opening resolution, junction/overlap errors, centreline room areas', () => {
  const { model, errors } = buildModel(normalizeSpec(tiny()).spec);
  assert.deepEqual(errors, []);
  const d1 = model.openings.find(o => o.id === 'D1');
  assert.equal(d1.clear, 780); assert.equal(d1.wallKind, 'int'); assert.equal(d1.swingSign, -1 * Math.sign(d1.frame.n[0]) * -1);
  assert.deepEqual(model.rooms.map(r => r.areaM2), [2.73 * 3.64, 1.82 * 3.64].map(a => Math.round(a * 100) / 100));
  assert.ok(model.columns.some(c => c.at[0] === 0 && c.at[1] === 0) && model.columns.some(c => c.at[0] === 2730 && c.at[1] === 0));
  const crossing = buildModel(normalizeSpec({ ...tiny(), openings: [{ id: 'X', type: 'window-sliding', at: [2730, 0], width: 910 }] }).spec);
  assert.ok(crossing.errors.some(e => /crosses a wall junction/u.test(e)));
  const inner = buildModel(normalizeSpec({ ...tiny(), openings: [{ id: 'X', type: 'window-sliding', at: [2730, 1365], width: 910 }] }).spec);
  assert.ok(inner.errors.some(e => /exterior wall/u.test(e)));
});

test('geometry: mitred offsets, union boundary corners/T-junction, interval and ring clipping', () => {
  const sq = normalizePolygon([[0, 0], [0, 1000], [1000, 1000], [1000, 0]]);           // given clockwise -> CCW
  assert.ok(signedArea(sq) > 0);
  assert.deepEqual(offsetPolygon(sq, EXT.out).map(p => p.join()).sort(), ['-185,-185', '-185,1185', '1185,-185', '1185,1185']);
  const L = normalizePolygon([[0, 0], [2000, 0], [2000, 1000], [1000, 1000], [1000, 2000], [0, 2000]]);
  assert.deepEqual(offsetPolygon(L, 65)[3], [935, 935]);                                  // reflex corner stays mitred
  // T-junction: horizontal bar + vertical stem -> boundary has no segment crossing the junction
  const rects = [{ x1: 0, y1: -65, x2: 2000, y2: 65 }, { x1: 935, y1: 0, x2: 1065, y2: 1000 }];
  const g = cellGrid(rects.flatMap(r => [r.x1, r.x2]), rects.flatMap(r => [r.y1, r.y2]), (x, y) => rects.some(r => x > r.x1 && x < r.x2 && y > r.y1 && y < r.y2));
  const segs = gridBoundary(g);
  assert.ok(!segs.some(([a, b]) => a[1] === 65 && b[1] === 65 && Math.min(a[0], b[0]) < 935 && Math.max(a[0], b[0]) > 1065), 'upper face is broken by the stem');
  assert.ok(segs.some(([a, b]) => a[1] === -65 && b[1] === -65 && Math.abs(a[0] - b[0]) === 2000), 'lower face runs through');
  assert.deepEqual(subtractIntervals(0, 1000, [[100, 200], [900, 1200]]), [[0, 100], [200, 900]]);
  assert.deepEqual(clipLineToRings([-10, 500], [1, 0], [sq, offsetPolygon(sq, 100)]), [[10, 110], [910, 1010]]);
});

test('drawPlan: new document from zero, layers/pens/scales, wall offsets, opening cuts, byte-exact re-encode', () => {
  const r = drawPlan(tiny()), doc = decodeJww(r.bytes);
  assert.ok(encodeJww(doc).equals(r.bytes));
  assert.equal(doc.header.m_adScale[1], SCALE); assert.equal(doc.header.m_adScale[0], 1);
  assert.equal(doc.header.m_aStrLayName[1][14], '寸法'); assert.equal(doc.header.m_aStrGLayName[1], '平面詳細図');
  const v = semanticView(doc), [sx, sy] = r.layout.shift, M = p => [p[0] * SCALE + sx, p[1] * SCALE + sy];
  const lines = v.entities.filter(e => e.kind === 'line').map(e => ({ layer: e.layer, color: e.pen.color, a: M(e.geometry.start), b: M(e.geometry.end) }));
  const near = (a, b) => Math.abs(a - b) < 0.01;
  // exterior assembly offsets on the south wall (y = offset)
  for (const [off, layer, color] of [[-185, '1:1', 2], [-170, '1:1', 4], [-152, '1:4', 1], [-62, '1:4', 1], [-52.5, '1:3', 4], [52.5, '1:3', 4], [65, '1:1', 2]])
    assert.ok(lines.some(l => l.layer === layer && l.color === color && near(l.a[1], off) && near(l.b[1], off)), `line at ${off} on ${layer}`);
  // clean mitred corner: outer face lines end exactly at (-185,-185)
  assert.equal(lines.filter(l => l.layer === '1:1' && l.color === 2 && [l.a, l.b].some(p => near(p[0], -185) && near(p[1], -185))).length, 2);
  // window W1 cut: no wall line passes through the rough opening (1820 - 130 = 1690 wide)
  const ro = [1365 - 845, 1365 + 845];
  assert.ok(!lines.some(l => ['1:1', '1:3', '1:4', '1:C'].includes(l.layer) && near(l.a[1], l.b[1]) && l.a[1] > -186 && l.a[1] < 66 && Math.min(l.a[0], l.b[0]) < ro[0] + 20 && Math.max(l.a[0], l.b[0]) > ro[1] - 20));
  assert.ok(v.entities.some(e => e.layer === '1:5' && e.kind === 'arc'), 'door swing arc');
  assert.ok(v.entities.some(e => e.layer === '1:A' && e.kind === 'arc' && e.pen.color === 8), 'insulation wave');
  assert.ok(v.entities.some(e => e.layer === '1:D' && e.kind === 'text' && e.geometry.text === '9.94㎡'), 'area label');
  assert.ok(!v.entities.some(e => e.layer === '1:A' && e.pen.color === 8 && Math.abs(M(e.geometry.center ?? e.geometry.start)[0] - 2730) < 60 && M(e.geometry.center ?? e.geometry.start)[1] > 200 && M(e.geometry.center ?? e.geometry.start)[1] < 3400), 'no insulation in the partition');
});

test('evaluatePlan: good plan scores 100, bad synthetic cases are caught', () => {
  const good = evaluatePlan(drawPlan(tiny()).bytes, tiny(), rules);
  assert.equal(good.score, 100, JSON.stringify(good.findings));
  // furniture blocking a door + swing into a wall + item in a wall
  const bad = tiny(); bad.items.push({ type: 'bed-single', at: [3100, 2275], rotation: 90 }, { type: 'washer', at: [2730, 1000] });
  const rb = evaluatePlan(drawPlan(bad).bytes, bad, rules);
  assert.ok(byId(rb, 'door-approach-clear').ratio < 1 && byId(rb, 'items-fit-rooms').ratio < 1 && rb.score < good.score);
  // a room without a door is unreachable; a bedroom without a window is flagged
  const closed = { ...tiny(), openings: tiny().openings.filter(o => o.id !== 'D1' && o.id !== 'W2'), rooms: [tiny().rooms[0], { name: '寝室', at: [3640, 1500], kind: 'bedroom' }] };
  const rc = evaluatePlan(drawPlan(closed).bytes, closed, rules);
  assert.ok(byId(rc, 'rooms-reachable').details.some(d => /寝室 unreachable/u.test(d)));
  assert.ok(byId(rc, 'habitable-rooms-have-windows').ratio < 1);
  // tampered drawing: delete one wall face line and recolour a furniture line -> closure / pen checks fail
  const doc = decodeJww(drawPlan(tiny()).bytes);
  doc.entities = doc.entities.filter((e, i, all) => !(e.cls === 'CDataSen' && e.layer === '1:1' && e.props.m_nPenColor === 2 && all.indexOf(e) === all.findIndex(x => x.cls === 'CDataSen' && x.layer === '1:1' && x.props.m_nPenColor === 2)));
  const furn = doc.entities.find(e => e.layer === '1:7'); furn.props.m_nPenStyle = 1;
  doc.dirty = true;
  const rt = evaluatePlan(encodeJww(doc), tiny(), rules);
  assert.ok(byId(rt, 'wall-closure').ratio < 1 || byId(rt, 'thick-faces-on-walls').ratio < 1);
  assert.ok(byId(rt, 'furniture-dashed').ratio < 1 && byId(rt, 'pen-per-layer').ratio < 1);
});

test('evaluatePlan: dimension-module flags non-module values outside an opening tier', () => {
  const r = drawPlan(tiny()), doc = decodeJww(r.bytes), [sx, sy] = r.layout.shift;
  // move the S grid-tier break point at x=455 to 445 (and its text), simulating a non-module grid dimension
  const s = doc.header.m_adScale[1], X = x => (x - sx) / s;
  let moved = 0;
  for (const e of doc.entities) if (e.layer === '1:E' && e.cls === 'CDataTen' && Math.abs(e.props.m_start_x - X(455)) < 1e-6 && e.props.m_start_y * s + sy < -1000) { e.props.m_start_x = X(445); moved++; }
  assert.ok(moved >= 1);
  doc.dirty = true;
  const res = evaluatePlan(encodeJww(doc), tiny(), rules);
  assert.ok(byId(res, 'dimension-module').ratio < 1 || byId(res, 'dimension-sum-equals-overall').ratio < 1);
});

test('examples: every shipped spec validates and draws', async () => {
  for (const name of ['house-a-shell', 'plan-2ldk-73', 'plan-3ldk-93', 'plan-1ldk-46', 'plan-l-2ldk-70']) {
    const spec = JSON.parse(await readFile(new URL(`../generator/examples/${name}.json`, import.meta.url), 'utf8'));
    const v = validateSpec(spec); assert.ok(v.ok, `${name}: ${v.errors.join('; ')}`);
    const r = drawPlan(spec); assert.ok(r.layout.fits, name);
    const e = evaluatePlan(r.bytes, spec, rules); assert.ok(e.subscores.drafting >= 99, `${name} drafting ${e.subscores.drafting}`);
  }
});

test('DLL reader reopens a generated plan with the same entity count', { skip: !process.env.FRESCO_JWW_FIXTURE, timeout: 300000 }, async () => {
  const { readJww } = await import('../native/jww.mjs');
  const r = drawPlan(tiny()), native = await readJww(r.bytes);
  assert.equal(native.entities.length, r.doc.entities.length);
});
