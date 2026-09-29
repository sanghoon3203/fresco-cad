import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStructure } from '../native/jww-structure.mjs';

const entity = (id, type, props = {}) => ({ id, type, props: { m_nGLayer: 0, m_nLayer: 0, ...props } });
const line = (id = 'b0/e0') => entity(id, 'JwwSen', { m_start_x: 1, m_start_y: 2, m_end_x: 3, m_end_y: 4 });
const block = (id, number = 0, extra = {}) => entity(id, 'JwwBlock', { m_nNumber: number, m_DPKijunTen_x: 10, m_DPKijunTen_y: 20, m_dBairitsuX: -2, m_dBairitsuY: 3, m_radKaitenKaku: Math.PI / 2, ...extra });
const definition = (entities, id = 'b0', number = 0) => ({ id, number, name: 'fixture', declaredCount: entities.length, entities });
const document = (entities, blocks) => ({ layers: [{ id: '0:0', scale: 50 }], entities, blocks });
const near = (actual, expected) => actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) < 1e-8, `${actual} != ${expected}`));

test('block reflection, nonuniform scale, rotation and group scale compose once per instance', () => {
  const doc = document([block('e0'), block('e1', 0, { m_DPKijunTen_x: 100 })], [definition([line()])]);
  const result = buildStructure(doc);
  near(result.expanded[0].modelPoints, [200, 900, -100, 700]);
  near(result.expanded[1].modelPoints, [4700, 900, 4400, 700]);
  assert.deepEqual(result.expanded.map(e => e.path), ['e0/b0/e0', 'e1/b0/e0']);
  assert.equal(result.definitions[0].entities[0].editable, false);
  assert.equal(result.coverage.definitionEntities, 1);
  assert.equal(result.coverage.blockInstances, 2);
  assert.deepEqual(doc.blocks[0].entities[0], line());
});

test('nested definition translations inherit parent transform without applying scale twice', () => {
  const plain = { m_radKaitenKaku: 0, m_dBairitsuX: 1, m_dBairitsuY: 1 };
  const result = buildStructure(document([block('e0', 0, plain)], [
    definition([block('b0/e0', 1, { ...plain, m_DPKijunTen_x: 5, m_DPKijunTen_y: 6 })]),
    definition([line('b1/e0')], 'b1', 1)
  ]));
  near(result.expanded[0].modelPoints, [800, 1400, 900, 1500]);
  assert.equal(result.expanded[0].path, 'e0/b0/e0/b1/e0');
});

test('missing, duplicate, cyclic, invalid and excessive block expansions are explicit diagnostics', () => {
  const missing = buildStructure(document([block('e0')], []));
  assert.equal(missing.instances[0].status, 'unresolved');
  assert.equal(missing.diagnostics[0].code, 'MISSING_BLOCK_DEFINITION');
  const cycle = buildStructure(document([block('e0')], [definition([block('b0/e0')])]));
  assert.ok(cycle.diagnostics.some(d => d.code === 'BLOCK_CYCLE'));
  const duplicate = buildStructure(document([block('e0')], [definition([line()]), definition([], 'b1')]));
  assert.ok(duplicate.diagnostics.some(d => d.code === 'DUPLICATE_BLOCK_NUMBER'));
  const invalid = buildStructure(document([block('e0', 0, { m_radKaitenKaku: null })], [definition([line()])]));
  assert.equal(invalid.instances[0].status, 'unresolved');
  assert.equal(invalid.diagnostics[0].code, 'INVALID_TRANSFORM');
  const limited = buildStructure(document([block('e0')], [definition([line()])]), { maxExpanded: 1 });
  assert.equal(limited.coverage.truncated, true);
  assert.equal(limited.expanded.length, 0);
});

test('invalid scale/coordinates are not silently interpreted as zero; ellipse retains affine transform', () => {
  const bad = line('e0'); bad.props.m_start_x = null;
  const result = buildStructure(document([bad], []));
  assert.equal(result.expanded[0].modelPoints, undefined);
  assert.equal(result.diagnostics[0].code, 'INVALID_GEOMETRY');
  const doc = document([line('e0')], []); doc.layers[0].scale = 0;
  assert.equal(buildStructure(doc).diagnostics[0].code, 'INVALID_SCALE');
  const arc = entity('b0/e0', 'JwwEnko', { m_start_x: 0, m_start_y: 0, m_dHankei: 2, m_dHenpeiRitsu: 1, m_radKatamukiKaku: 0, m_radKaishiKaku: 0, m_radEnkoKaku: Math.PI, m_bZenEnFlg: 0 });
  const expanded = buildStructure(document([block('e0')], [definition([arc])])).expanded[0];
  assert.equal(expanded.geometry.kind, 'ellipse-arc');
  assert.equal(expanded.geometry.radius, 2);
  assert.equal(expanded.transformToModel.length, 6);
});
