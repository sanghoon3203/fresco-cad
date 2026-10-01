import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildStructure } from '../native/jww-structure.mjs';
import { validatePatchV2 } from '../core/patch-v2.mjs';
import { observeDrawing, buildProfile, assignLayerRole, roleFromName, checkLayers, checkPatchLayers, applyLayerCorrections, suggestLayer, validateProfile, ROLES } from '../core/layer-profile.mjs';

// ---- synthetic documents (paper mm coordinates, scale 100)
const gl = id => id.split(':').map(v => parseInt(v, 16));
const pr = (layer, extra = {}) => ({ m_nGLayer: gl(layer)[0], m_nLayer: gl(layer)[1], m_nPenColor: 1, m_nPenStyle: 1, m_nPenWidth: 0, m_lGroup: 0, m_sFlg: 0, ...extra });
const line = (id, layer, [x1, y1, x2, y2], extra) => ({ id, type: 'JwwSen', props: pr(layer, { m_start_x: x1, m_start_y: y1, m_end_x: x2, m_end_y: y2, ...extra }) });
const text = (id, layer, s, h = 3, extra) => ({ id, type: 'JwwMoji', props: pr(layer, { m_string: s, m_dSizeX: h, m_dSizeY: h, m_nMojiShu: 3, m_strFontName: 'MS', m_degKakudo: 0, m_start_x: 0, m_start_y: 0, m_end_x: 5, m_end_y: 0, ...extra }) });
const dim = (id, layer) => ({ id, type: 'JwwSunpou', props: pr(layer), components: [line(`${id}/line`, layer, [0, 0, 9.1, 0]), text(`${id}/text`, layer, '910', 2.5)] });
const block = (id, layer, number = 0) => ({ id, type: 'JwwBlock', props: pr(layer, { m_nNumber: number, m_DPKijunTen_x: 10, m_DPKijunTen_y: 20, m_dBairitsuX: 1, m_dBairitsuY: 1, m_radKaitenKaku: 0 }) });
const layerDef = (id, name = '', scale = 100) => ({ id, groupName: '', name, scale, state: 2 });
const doc = (layers, entities, blocks = []) => ({ version: 700, layers, entities, blocks, diagnostics: [] });
const rooms = ['洋室', '和室', '浴室', 'トイレ', '玄関', '廊下', '収納', 'キッチン', 'リビング', '洗面'];
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));

// A drawing following an office convention: named layers 0:0 通り芯 0:1 壁 0:3 建具 0:6 室名 0:7 寸法, plus unnamed layers identified by content only.
function officeDrawing(variant = 0) {
  const entities = [
    ...many(6, i => line(`e${i}`, '0:0', i % 2 ? [i * 10, 0, i * 10, 200] : [0, i * 10, 200, i * 10], { m_nPenStyle: 5 })),
    ...many(12, i => line(`w${i}`, '0:1', [i, 0, i + 30, i % 3 ? 0 : 20], { m_nPenColor: 2 })),
    ...many(10, i => line(`d${i}`, '0:3', [i, 5, i + 9, 5], { m_nPenColor: 3 })),
    ...many(10, i => text(`t${i}`, '0:6', rooms[(i + variant) % rooms.length])),
    ...many(6, i => dim(`m${i}`, '0:7')),
    ...many(8, i => line(`a${i}`, '0:A', [0, i * 7, 150, i * 7], { m_nPenStyle: 4 })),
    ...many(8, i => text(`b${i}`, '0:B', rooms[i], 2.5)),
    ...many(5, i => line(`u${i}`, '0:F', [i, i, i + 3, i + 4])),
    text('title', '0:E', `${variant + 1}階平面図`, 6)
  ];
  const layers = [layerDef('0:0', '通り芯'), layerDef('0:1', ' 壁'), layerDef('0:3', '建具'), layerDef('0:6', '室名'), layerDef('0:7', '寸法'),
    layerDef('0:A'), layerDef('0:B', '１-１ﾚｲﾔ'), layerDef('0:E'), layerDef('0:F')];
  return doc(layers, entities);
}
const observe = (i, d = officeDrawing(i)) => observeDrawing(d, { name: `office-${i}.jww`, sourceHash: String(i).padStart(64, '0') });
const corpus = [0, 1, 2, 3].map(i => observe(i));
const profile = buildProfile(corpus);
const ir = d => { const s = buildStructure(d); return { schemaVersion: 2, sourceHash: 'h', layers: d.layers, entities: s.entities.map(e => ({ ...e, layerId: e.layerId })), blockDefinitions: s.definitions, expandedEntities: s.expanded, blockInstances: s.instances }; };
const rule = (r, id) => r.findings.filter(f => f.ruleId === id);

test('observeDrawing: kinds, pens, orientation, lengths, bbox, text samples per layer', () => {
  const o = observe(0), by = id => o.layers.find(l => l.id === id);
  assert.equal(o.schemaVersion, 1);
  assert.equal(o.counts.topLevel, 66);
  assert.deepEqual(Object.keys(by('0:0').top.kinds), ['line']);
  assert.deepEqual(by('0:0').top.styles, { 5: 6 });
  assert.equal(by('0:0').top.lines.h + by('0:0').top.lines.v, 6);
  assert.equal(by('0:0').top.lines.typical.max, 200);
  assert.deepEqual(by('0:1').top.colors, { 2: 12 });
  assert.ok(by('0:1').top.lines.d > 0);
  assert.deepEqual(by('0:6').top.heights, { 3: 10 });
  assert.deepEqual(by('0:6').top.mojiShu, { 3: 10 });
  assert.ok(by('0:6').text.samples.length <= 5 && by('0:6').text.samples.every(s => s.length <= 25));
  assert.equal(by('0:6').text.roomHits, 10);
  assert.deepEqual(by('0:7').top.kinds, { dim: 6 }, 'dimension parts must not be double counted');
  assert.equal(by('0:7').child.count, 0);
  assert.deepEqual(by('0:0').bbox, [0, 0, 20000, 20000], 'bounding box is model mm (paper x scale)');
  assert.equal(by('0:1').name, ' 壁');
  assert.equal(by('0:1').scale, 100);
});

test('observeDrawing counts block children on the block layer and long texts are truncated', () => {
  const d = doc([layerDef('0:4', '設備')], [block('e0', '0:4'), text('e1', '0:4', 'あ'.repeat(80))],
    [{ id: 'b0', number: 0, name: 'sym', declaredCount: 2, entities: [line('b0/e0', '0:0', [0, 0, 4, 0], { m_nPenColor: 5 }), text('b0/e1', '0:0', 'X', 2)] }]);
  const l = observeDrawing(d).layers.find(x => x.id === '0:4');
  assert.deepEqual(l.top.kinds, { block: 1, text: 1 });
  assert.deepEqual(l.child.kinds, { line: 1, text: 1 });
  assert.deepEqual(l.child.colors, { 5: 1, 1: 1 });
  assert.equal(l.child.lines.n, 1);
  assert.ok(l.text.samples[0].length <= 25 && l.text.samples[0].endsWith('…'));
  assert.equal(observeDrawing(d).layers.some(x => x.id === '0:0'), false, 'children are not attributed to their own layer');
});

test('drawing type is a candidate with evidence', () => {
  const t = observe(0).drawingType;
  assert.equal(t.candidate, true);
  assert.equal(t.best, 'plan');
  assert.ok(t.candidates[0].evidence.length >= 1 && t.candidates[0].confidence > 0.5);
  const elev = observeDrawing(doc([layerDef('0:0', '南立面')], [text('e0', '0:0', '南立面図'), line('e1', '0:0', [0, 0, 1, 1])]));
  assert.equal(elev.drawingType.best, 'elevation');
  assert.equal(observeDrawing(doc([layerDef('0:0')], [line('e0', '0:0', [0, 0, 1, 1])])).drawingType.best, 'unknown');
});

test('role by layer name: Japanese keywords, width/whitespace normalization, specific roles first', () => {
  const r = n => roleFromName(n)?.role ?? null;
  assert.equal(r('通り芯'), 'grid'); assert.equal(r(' 芯'), 'grid'); assert.equal(r('Ｇｒｉｄ'), 'grid');
  assert.equal(r('　躯体'), 'wall'); assert.equal(r('間仕切り'), 'wall'); assert.equal(r('インドア壁'), 'wall', 'インドア must not match ドア');
  assert.equal(r('建具'), 'opening'); assert.equal(r('西サッシ'), 'opening'); assert.equal(r('窓'), 'opening');
  assert.equal(r('壁仕上'), 'finish'); assert.equal(r('擁壁'), 'site'); assert.equal(r('敷地'), 'site');
  assert.equal(r('室名'), 'text'); assert.equal(r('　寸法'), 'dimension'); assert.equal(r('設備機器'), 'equipment');
  assert.equal(r(' ｴﾚﾍﾞ-ﾀ'), 'equipment'); assert.equal(r('家具'), 'furniture'); assert.equal(r('図枠'), 'frame'); assert.equal(r('補助線'), 'auxiliary');
  assert.equal(r('屋　根'), 'roof'); assert.equal(r('玄関柱'), 'structure'); assert.equal(r('南立面'), 'elevation');
  assert.equal(r('１-０ﾚｲﾔ'), null, 'Jw_cad default names carry no meaning');
  assert.equal(r(''), null); assert.equal(r('YKK_A1'), null); assert.equal(r('本体'), null);
  assert.equal(roleFromName('', 'サッシ').confidence, 0.45, 'group name fallback is weak');
  assert.equal(roleFromName('', '敷地・建物'), null, 'site group names must not label every layer');
  assert.equal(roleFromName('壁').confidence, 0.8); assert.equal(roleFromName('建具').confidence, 0.9);
});

test('role by content: chain lines, dimensions, room-name texts; unknown stays unknown', () => {
  const o = observe(0), by = id => assignLayerRole(o.layers.find(l => l.id === id));
  assert.equal(by('0:A').role, 'grid'); assert.equal(by('0:A').source, 'content'); assert.ok(by('0:A').evidence[0].includes('chain-line'));
  assert.equal(by('0:B').role, 'text'); assert.equal(by('0:B').source, 'content'); assert.ok(by('0:B').confidence >= 0.7);
  assert.equal(by('0:E').role, 'unknown'); assert.equal(by('0:F').role, 'unknown');
  assert.equal(by('0:F').confidence, 0); assert.ok(by('0:F').evidence.length);
  const dims = assignLayerRole(observeDrawing(doc([layerDef('0:C')], many(5, i => dim(`e${i}`, '0:C')))).layers[0]);
  assert.deepEqual([dims.role, dims.source], ['dimension', 'content']);
  // name + agreeing content boosts; name + conflicting content lowers; compatible content (text in 寸法) does not
  assert.equal(by('0:0').source, 'name+content'); assert.ok(by('0:0').confidence > 0.9);
  const conflict = assignLayerRole(observeDrawing(doc([layerDef('0:1', '壁')], many(8, i => text(`e${i}`, '0:1', rooms[i])))).layers[0]);
  assert.equal(conflict.role, 'wall'); assert.ok(conflict.confidence < 0.9 && conflict.evidence.some(e => e.includes('content suggests text')));
  const compatible = assignLayerRole(observeDrawing(doc([layerDef('0:7', '寸法')], many(8, i => text(`e${i}`, '0:7', String(900 + i))))).layers[0]);
  assert.equal(compatible.role, 'dimension'); assert.equal(compatible.confidence, 0.9);
});

test('buildProfile aggregates roles with support, confidence, allowed pens and text sizes', () => {
  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.kind, 'jw-office-layer-profile');
  assert.equal(profile.drawingCount, 4);
  assert.equal(validateProfile(profile), profile);
  const r = id => profile.roles[id];
  assert.equal(r('grid').support, 4);
  assert.deepEqual(r('grid').layers.filter(l => l.primary).map(l => l.layerId).sort(), ['0:0', '0:A']);
  assert.deepEqual(r('grid').allowed.styles, [4, 5]);
  assert.deepEqual(r('grid').gridStyles, [4, 5], 'learned from long lines on grid layers');
  assert.equal(profile.layers['0:0'].role, 'grid'); assert.equal(profile.layers['0:0'].support, 4); assert.ok(profile.layers['0:0'].confidence >= 0.9);
  assert.equal(profile.layers['0:1'].role, 'wall'); assert.deepEqual(profile.layers['0:1'].allowed.colors, [2]);
  assert.deepEqual(profile.layers['0:3'].allowed.colors, [3]);
  assert.equal(profile.layers['0:6'].role, 'text'); assert.deepEqual(profile.layers['0:6'].allowed.textHeights, [3]);
  assert.equal(profile.layers['0:7'].role, 'dimension');
  assert.equal(profile.layers['0:B'].role, 'text', 'unnamed layer classified by content');
  assert.equal(profile.layers['0:F'].role, 'unknown');
  assert.ok(profile.roles.text.allowed.textHeights.includes(3) && profile.roles.text.allowed.textHeights.includes(2.5));
  assert.deepEqual(profile.roles.wall.names[0], { name: '壁', count: 4 });
  assert.deepEqual(profile.drawingTypes, { plan: 4 });
  assert.ok(profile.usage.enabled && profile.usage.usedLayers.includes('0:3') && !profile.usage.usedLayers.includes('0:9'));
  assert.equal(profile.roles.unknown, undefined);
});

test('profile keeps only hashes+names of sources, no sample texts unless asked', () => {
  assert.deepEqual(profile.sourceDrawings.map(s => Object.keys(s).sort().join()), Array(4).fill('name,sha256'));
  const json = JSON.stringify(profile);
  assert.ok(!json.includes('洋室') && !json.includes('階平面図'), 'sample texts must not leak');
  assert.ok(!Object.values(profile.layers).some(l => 'samples' in l));
  const withSamples = buildProfile(corpus, { keepSamples: true });
  assert.ok(withSamples.layers['0:6'].samples.length <= 5 && withSamples.layers['0:6'].samples.every(s => typeof s === 'string'));
});

test('minSupport demotes layers seen in too few drawings to unknown; effective support follows drawing count', () => {
  const odd = observeDrawing(doc([layerDef('1:5', '家具')], many(12, i => line(`e${i}`, '1:5', [0, i, 5, i]))), { name: 'odd', sourceHash: 'x' });
  const p = buildProfile([...corpus, odd], { minSupport: 2 });
  assert.equal(p.layers['1:5'].role, 'unknown'); assert.equal(p.layers['1:5'].lowSupport, true); assert.equal(p.layers['1:5'].candidateRole, 'furniture');
  assert.equal(p.roles.furniture.layers[0].lowSupport, true, 'role pool still records it');
  assert.ok(p.usage.usedLayers.includes('1:5'));
  const single = buildProfile([odd], { minSupport: 3 });
  assert.equal(single.params.effectiveMinSupport, 1); assert.equal(single.layers['1:5'].role, 'furniture'); assert.equal(single.usage.enabled, false);
  assert.throws(() => buildProfile([]), e => e.code === 'E_LAYER_PROFILE_EMPTY');
  assert.throws(() => buildProfile([{}]), e => e.code === 'E_LAYER_PROFILE_INPUT');
  assert.throws(() => validateProfile({}), e => e.code === 'E_LAYER_PROFILE_SCHEMA');
});

test('profile and findings are deterministic regardless of observation order', () => {
  const again = buildProfile([...corpus].reverse());
  assert.equal(JSON.stringify(again), JSON.stringify(profile));
  const d = officeDrawing(0); d.entities.push(text('x1', '0:1', 'メモ'), line('x2', '0:3', [0, 0, 5, 5], { m_nPenColor: 9 }), dim('x3', '0:1'));
  const a = checkLayers(d, profile), b = checkLayers(structuredClone(d), profile);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const order = a.findings.map(f => ['error', 'warning', 'info'].indexOf(f.severity));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
});

test('checkLayers: entity kind not expected on a layer (dimension and text on 壁)', () => {
  const d = officeDrawing(0); d.entities.push(dim('x1', '0:1'), text('x2', '0:1', '余計'), text('x3', '0:1', '余計2'));
  const r = checkLayers(d, profile), k = rule(r, 'layer.kind-unexpected').filter(f => f.layerId === '0:1');
  assert.deepEqual(k.map(f => f.actual.kind).sort(), ['dim', 'text']);
  const t = k.find(f => f.actual.kind === 'text');
  assert.deepEqual(t.entityIds, ['x2', 'x3']); assert.equal(t.count, 2);
  assert.equal(t.severity, 'error'); assert.deepEqual(t.expected.forbidden, ['text', 'dim']);
  assert.match(t.message_ja, /壁/); assert.match(t.message_ko, /벽/);
  for (const f of r.findings) assert.ok(f.id && f.ruleId && f.layerId && f.expected && f.actual && f.message_ja && f.message_ko && Array.isArray(f.entityIds));
  assert.equal(r.summary.error, 2);
});

test('checkLayers: a kind that dominates the layer is info (purpose mismatch), not a stray error', () => {
  const d = doc([layerDef('0:1', '壁')], many(8, i => text(`e${i}`, '0:1', rooms[i])).concat(line('l0', '0:1', [0, 0, 9, 0], { m_nPenColor: 2 })));
  const f = rule(checkLayers(d, profile), 'layer.kind-unexpected');
  assert.deepEqual(f.map(x => [x.severity, x.actual.kind, x.actual.layerShare]), [['info', 'text', 0.89]]);
  assert.match(f[0].message_ja, /89%/); assert.match(f[0].message_ko, /89%/);
});

test('checkLayers: gridStyles option forces a strict grid line type', () => {
  const d = officeDrawing(0); d.entities.push(line('g1', '0:0', [0, 90, 200, 90], { m_nPenStyle: 4 }));
  assert.equal(rule(checkLayers(d, profile), 'grid.linetype').length, 0);
  const strict = rule(checkLayers(d, profile, { gridStyles: [5] }), 'grid.linetype');
  assert.ok(strict.flatMap(f => f.entityIds).includes('g1') && strict.every(f => f.actual.style === 4));
});

test('checkLayers: lines on a text layer are unusual; clean drawing has no errors or warnings', () => {
  const clean = checkLayers(officeDrawing(1), profile);
  assert.equal(clean.summary.error + clean.summary.warning, 0, JSON.stringify(clean.findings.map(f => f.id)));
  const d = officeDrawing(0); d.entities.push(line('x1', '0:6', [0, 0, 10, 0]));
  const f = rule(checkLayers(d, profile), 'layer.kind-unexpected');
  assert.deepEqual(f.map(x => [x.layerId, x.actual.kind, x.actual.tier, x.severity]), [['0:6', 'line', 'unusual', 'warning']]);
});

test('checkLayers: pen color, line type and width outside the layer set', () => {
  const d = officeDrawing(0);
  d.entities.push(line('c1', '0:1', [0, 0, 9, 0], { m_nPenColor: 7 }), line('s1', '0:1', [0, 1, 9, 1], { m_nPenStyle: 3, m_nPenColor: 2 }), line('w1', '0:1', [0, 2, 9, 2], { m_nPenWidth: 40, m_nPenColor: 2 }));
  const r = checkLayers(d, profile);
  assert.deepEqual(rule(r, 'layer.pen-color').map(f => [f.layerId, f.actual.color, f.entityIds[0], f.severity]), [['0:1', 7, 'c1', 'warning']]);
  assert.deepEqual(rule(r, 'layer.pen-style').map(f => [f.layerId, f.actual.style]), [['0:1', 3]]);
  assert.deepEqual(rule(r, 'layer.pen-width').map(f => [f.actual.width, f.severity]), [[40, 'info']]);
  assert.match(rule(r, 'layer.pen-style')[0].message_ja, /点線2/);
});

test('checkLayers: text height must be one of the layer sizes', () => {
  const d = officeDrawing(0); d.entities.push(text('h1', '0:6', '洋室', 7.5), text('h2', '0:6', '和室', 3.02));
  const f = rule(checkLayers(d, profile), 'layer.text-height');
  assert.deepEqual(f.map(x => [x.layerId, x.actual.height, x.entityIds]), [['0:6', 7.5, ['h1']]], '3.02 is within tolerance of 3');
  assert.deepEqual(f[0].expected.heights, [3]);
});

test('checkLayers: layers the profile never saw are info; unusable evidence never raises errors', () => {
  const d = officeDrawing(0); d.layers.push(layerDef('2:2', 'メモ')); d.entities.push(line('n1', '2:2', [0, 0, 1, 1]));
  const f = rule(checkLayers(d, profile), 'layer.unused');
  assert.deepEqual(f.map(x => [x.layerId, x.severity, x.entityIds]), [['2:2', 'info', ['n1']]]);
  const few = buildProfile(corpus.slice(0, 2));
  assert.equal(rule(checkLayers(d, few), 'layer.unused').length, 0, 'fewer than 3 drawings: unused policy disabled');
});

test('checkLayers: grid lines must follow the grid line type; short ticks are ignored', () => {
  const d = officeDrawing(0);
  d.entities.push(line('g1', '0:0', [0, 90, 200, 90], { m_nPenStyle: 1 }), line('g2', '0:0', [0, 91, 5, 91], { m_nPenStyle: 1 }));
  const r = checkLayers(d, profile), f = rule(r, 'grid.linetype');
  assert.deepEqual(f.map(x => [x.layerId, x.entityIds, x.actual.style, x.expected.styles]), [['0:0', ['g1'], 1, [4, 5]]]);
  assert.deepEqual(rule(r, 'layer.pen-style').filter(x => x.layerId === '0:0').map(x => x.entityIds), [['g2']], 'long grid lines only get the grid finding; the short tick gets the generic one');
  assert.match(f[0].message_ja, /一点鎖線/); assert.match(f[0].message_ko, /일점쇄선/);
});

test('checkLayers: a layer name that disagrees with the office role is flagged; IR input equals document input', () => {
  const d = officeDrawing(0); d.layers.find(l => l.id === '0:3').name = '寸法';
  const r = checkLayers(d, profile), f = rule(r, 'layer.role-mismatch');
  assert.deepEqual(f.map(x => [x.layerId, x.expected.role, x.actual.role]), [['0:3', 'opening', 'dimension']]);
  const d2 = officeDrawing(0); d2.entities.push(dim('x1', '0:1'));
  assert.equal(JSON.stringify(checkLayers(ir(d2), profile)), JSON.stringify(checkLayers(d2, profile)));
  assert.throws(() => checkLayers({}, profile), e => e.code === 'E_LAYER_PROFILE_INPUT');
  assert.throws(() => checkLayers(d, {}), e => e.code === 'E_LAYER_PROFILE_SCHEMA');
});

test('checkLayers: a layer not in the profile but named for a role is checked against the role', () => {
  const d = doc([layerDef('3:3', '壁')], [...many(3, i => line(`l${i}`, '3:3', [0, i, 9, i])), text('t1', '3:3', 'x')]);
  const f = rule(checkLayers(d, profile), 'layer.kind-unexpected');
  assert.deepEqual(f.map(x => [x.layerId, x.actual.kind, x.severity]), [['3:3', 'text', 'error']]);
});

// ---- patches
const irOf = () => { const d = officeDrawing(0); d.entities.push(text('tx', '0:6', '洋室'), line('wl', '0:1', [0, 0, 9, 0], { m_nPenColor: 2 })); return ir(d); };
const patchIr = irOf();
const norm = ops => validatePatchV2({ schemaVersion: 2, sourceHash: 'h', units: 'model-mm', ops, rationale: 'r', needsClarification: null }, patchIr).ops;
const addLine = (layer, extra = {}) => ({ op: 'add', tempId: 'n0', entity: { kind: 'line', layer, start: [0, 0], end: [910, 0], pen: { color: null, style: null, width: null, ...extra } } });
const addText = (layer, height = null) => ({ op: 'add', tempId: 'n1', entity: { kind: 'text', layer, at: [0, 0], text: '洋室', height, width: null, spacing: null, angle: null, style: null, color: null } });

test('checkPatchLayers: wall line added on the text layer is corrected to the wall layer', () => {
  const ops = norm([addLine('0:6')]), r = checkPatchLayers(ops, patchIr, profile);
  assert.equal(r.verdict, 'correctable');
  const f = r.findings.find(x => x.ruleId === 'patch.kind-unexpected');
  assert.deepEqual([f.layerId, f.opIndex, f.tempId, f.suggestedLayer, f.severity], ['0:6', 0, 'n0', '0:1', 'warning']);
  assert.deepEqual(r.suggestions, [{ opIndex: 0, tempId: 'n0', kind: 'line', layer: '0:6', suggestedLayer: '0:1', suggestedRole: 'wall', reason: 'popular-for-kind', changed: true }]);
  const hinted = checkPatchLayers(ops, patchIr, profile, { roleHint: 'opening' });
  assert.equal(hinted.suggestions[0].suggestedLayer, '0:3'); assert.equal(hinted.suggestions[0].reason, 'role-hint');
  const fixed = applyLayerCorrections(ops, hinted.corrections);
  assert.equal(fixed[0].entity.layer, '0:3'); assert.equal(ops[0].entity.layer, '0:6', 'input is not mutated');
  assert.equal(checkPatchLayers(fixed, patchIr, profile, { roleHint: 'opening' }).verdict, 'ok');
});

test('checkPatchLayers: role hint mismatch is an error on confident layers; text goes to the text layer', () => {
  const r = checkPatchLayers(norm([addLine('0:1')]), patchIr, profile, { roleHint: 'opening' });
  const f = r.findings.find(x => x.ruleId === 'patch.role-mismatch');
  assert.deepEqual([f.severity, f.expected.role, f.actual.role, f.suggestedLayer], ['error', 'opening', 'wall', '0:3']);
  assert.equal(r.verdict, 'correctable');
  const t = checkPatchLayers(norm([addText('0:1')]), patchIr, profile);
  const k = t.findings.find(x => x.ruleId === 'patch.kind-unexpected');
  assert.deepEqual([k.severity, k.actual.kind, k.suggestedLayer], ['error', 'text', '0:6']);
  assert.equal(t.suggestions[0].suggestedLayer, '0:6');
  assert.equal(checkPatchLayers(norm([addText('0:6')]), patchIr, profile).verdict, 'ok');
  assert.throws(() => checkPatchLayers(norm([addLine('0:1')]), patchIr, profile, { roleHint: 'bogus' }), e => e.code === 'E_LAYER_PROFILE_INPUT');
});

test('checkPatchLayers: off-standard text size, pen color and unused layers on add/setPen/modify', () => {
  const r = checkPatchLayers(norm([addText('0:6', 9), addLine('0:1', { color: 8 })]), patchIr, profile);
  assert.deepEqual(r.findings.map(f => f.ruleId).sort(), ['patch.pen-color', 'patch.text-height']);
  assert.equal(r.verdict, 'review');
  assert.deepEqual(r.findings.find(f => f.ruleId === 'patch.text-height').expected.heights, [3]);
  const nullHeight = checkPatchLayers(norm([addText('0:6', null)]), patchIr, profile);
  assert.equal(nullHeight.findings.length, 0, 'default height cannot be judged');
  const pen = checkPatchLayers(norm([{ op: 'setPen', ids: ['wl'], pen: { color: 6, style: null, width: null } }, { op: 'modify', id: 'tx', set: { start: null, end: null, at: null, center: null, radius: null, startAngle: null, sweepAngle: null, text: null, height: 11, width: null, angle: null } }]), patchIr, profile);
  assert.deepEqual(pen.findings.map(f => [f.ruleId, f.opIndex, f.layerId]).sort(), [['patch.pen-color', 0, '0:1'], ['patch.text-height', 1, '0:6']]);
});

test('checkPatchLayers: setLayer to a wrong role and temp ids tracked across ops', () => {
  const r = checkPatchLayers(norm([{ op: 'setLayer', ids: ['tx'], layer: '0:1' }]), patchIr, profile);
  const f = r.findings.find(x => x.ruleId === 'patch.kind-unexpected');
  assert.deepEqual([f.layerId, f.entityIds, f.actual.kind, f.suggestedLayer, f.severity], ['0:1', ['tx'], 'text', '0:6', 'error']);
  assert.deepEqual(r.corrections, [{ opIndex: 0, path: 'layer', from: '0:1', to: '0:6', role: 'text', reason: 'kind', ref: null }]);
  assert.equal(applyLayerCorrections(norm([{ op: 'setLayer', ids: ['tx'], layer: '0:1' }]), r.corrections)[0].layer, '0:6');
  const chained = checkPatchLayers(norm([addText('0:6'), { op: 'setLayer', ids: ['n1'], layer: '0:1' }]), patchIr, profile);
  assert.equal(chained.findings.filter(x => x.ruleId === 'patch.kind-unexpected' && x.opIndex === 1).length, 1);
  const ok = checkPatchLayers(norm([{ op: 'translate', ids: ['wl'], dx: 10, dy: 0 }, { op: 'delete', ids: ['tx'] }]), patchIr, profile);
  assert.deepEqual([ok.verdict, ok.findings.length], ['ok', 0]);
});

test('checkPatchLayers: chain line suggestion, determinism and uncorrectable errors reject', () => {
  const chain = norm([{ op: 'add', tempId: 'n0', entity: { kind: 'line', layer: '0:1', start: [0, 0], end: [9100, 0], pen: { color: null, style: 5, width: null } } }]);
  const s = checkPatchLayers(chain, patchIr, profile).suggestions[0];
  assert.deepEqual([s.suggestedLayer, s.suggestedRole, s.reason], ['0:0', 'grid', 'chain-line']);
  const a = checkPatchLayers(norm([addLine('0:6'), addText('0:1', 9)]), patchIr, profile), b = checkPatchLayers(norm([addLine('0:6'), addText('0:1', 9)]), patchIr, profile);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const noText = structuredClone(profile); delete noText.roles.text;
  assert.equal(checkPatchLayers(norm([addText('0:1')]), patchIr, noText).verdict, 'reject');
  assert.deepEqual(suggestLayer('text', {}, noText, new Map([['0:1', { id: '0:1' }]])), { layerId: null, role: null, reason: 'no-role' });
  assert.ok(ROLES.grid.ja && ROLES.grid.ko);
});

// ---- corpus (real drawings), gated
const corpusRoot = process.env.FRESCO_JWW_CORPUS;
test('corpus: observe, profile and check real drawings', { skip: !corpusRoot, timeout: 900000 }, async () => {
  const { readJww } = await import('../native/jww.mjs');
  const files = [];
  const walk = async dir => { for (const e of await readdir(dir, { withFileTypes: true })) { const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p); else if (/\.jww$/iu.test(e.name) && !/\.jw\$|^【自動保存】/u.test(e.name)) files.push(p); } };
  await walk(corpusRoot); files.sort();
  assert.ok(files.length >= 10, 'corpus has drawings');
  const docs = [];
  for (const f of files) docs.push({ name: path.basename(f), document: await readJww(await readFile(f)) });
  const observations = docs.map(({ name, document }) => observeDrawing(document, { name, sourceHash: name }));
  for (const o of observations) { assert.ok(o.counts.topLevel > 0); assert.ok(o.layers.length > 0); assert.ok(o.drawingType.candidate); }
  const mansion = observations.find(o => o.name.includes('マンション平面例'));
  if (mansion) {
    const role = id => assignLayerRole(mansion.layers.find(l => l.id === id)).role;
    assert.deepEqual([role('0:0'), role('0:1'), role('0:3'), role('0:6'), role('0:7')], ['grid', 'wall', 'opening', 'text', 'dimension']);
    assert.equal(mansion.drawingType.best, 'plan');
  }
  const p = buildProfile(observations);
  assert.equal(JSON.stringify(buildProfile([...observations].reverse())), JSON.stringify(p));
  assert.ok(Object.keys(p.roles).length >= 5);
  const json = JSON.stringify(p);
  const layerNames = new Set(observations.flatMap(o => o.layers.flatMap(l => [l.name.trim(), l.groupName.trim()])));
  for (const o of observations) for (const l of o.layers) for (const s of l.text.samples) if (Array.from(s).length >= 4 && !layerNames.has(s)) assert.ok(!json.includes(JSON.stringify(s).slice(1, -1)), `sample leaked: ${s}`);
  for (const { document } of docs.slice(0, 6)) {
    const a = checkLayers(document, p), b = checkLayers(document, p);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    for (const f of a.findings) assert.ok(f.message_ja && f.message_ko && f.entityIds.length);
  }
});
