import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../native/jww.mjs';
import { translate, toIR } from '../native/jww-pipeline.mjs';

function fixture() {
  const record = Buffer.alloc(47);
  record.writeUInt16LE(1, 5);
  [0, 0, 20, 0].forEach((v, i) => record.writeDoubleLE(v, 15 + i * 8));
  const bytes = Buffer.concat([Buffer.from('JwwData.'), Buffer.alloc(12), record, Buffer.from('opaque-tail')]);
  const document = { version: 700, blockDefinitions: 0, images: 0,
    layers: [{ id: '0:0', scale: 50 }], entities: [{ id: 'e0', type: 'JwwSen', record: record.toString('base64'),
      props: { m_lGroup: 0, m_sFlg: 0, m_nGLayer: 0, m_nLayer: 0, m_start_x: 0, m_start_y: 0, m_end_x: 20, m_end_y: 0 } }] };
  return { bytes, document, patch: { schemaVersion: 1, sourceHash: hash(bytes), op: 'TranslateEntities', ids: ['e0'], dx: 910, dy: 0, units: 'model-mm' } };
}
test('model mm translation respects scale and preserves all other bytes', () => {
  const { bytes, document, patch } = fixture(), original = Buffer.from(bytes);
  const ir = toIR(bytes, document);
  assert.deepEqual(ir.entities[0].points, [0, 0, 1000, 0]);
  assert.equal(ir.entities[0].editable, true);
  const result = translate(bytes, document, patch);
  assert.equal(result.bytes.readDoubleLE(35), 18.2);
  assert.equal(result.bytes.readDoubleLE(51), 38.2);
  assert.deepEqual(result.bytes.subarray(0, 35), bytes.subarray(0, 35));
  assert.deepEqual(result.bytes.subarray(67), bytes.subarray(67));
  assert.deepEqual(bytes, original);
});
test('zero translation is byte exact and inverse translation restores this fixture', () => {
  const { bytes, document, patch } = fixture();
  assert.deepEqual(translate(bytes, document, { ...patch, dx: 0 }).bytes, bytes);
  const forward = translate(bytes, document, { ...patch, dx: 1000 });
  const backward = translate(forward.bytes, forward.expected, { ...patch, sourceHash: hash(forward.bytes), dx: -1000 });
  assert.deepEqual(backward.bytes, bytes);
});
test('rejects stale, unknown, duplicate, partial-invalid and malformed patches', () => {
  const { bytes, document, patch } = fixture();
  for (const invalid of [{ sourceHash: 'stale' }, { ids: ['missing'] }, { ids: ['e0', 'missing'] },
    { ids: ['e0', 'e0'] }, { dx: Infinity }, { dx: '910' }, { units: 'mm' }, { extra: true }]) {
    assert.throws(() => translate(bytes, document, { ...patch, ...invalid }));
  }
  document.layers[0].scale = 0;
  assert.throws(() => translate(bytes, document, patch), { code: 'E_PATCH_SCALE' });
});
