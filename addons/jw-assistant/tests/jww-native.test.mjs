import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hash, readJww } from '../native/jww.mjs';
import { toIR, applyJwwPatch } from '../native/jww-pipeline.mjs';

test('native JWW integration: deterministic import, byte exact no-op, model-mm edit and unchanged remainder',
  { skip: !process.env.FRESCO_JWW_FIXTURE, timeout: 120000 }, async () => {
    const bytes = await readFile(process.env.FRESCO_JWW_FIXTURE);
    const doc = await readJww(bytes);
    assert.deepEqual(await readJww(bytes), doc);
    const ir = toIR(bytes, doc), entity = ir.entities.find(e => e.editable);
    assert.ok(entity, 'Fixture needs an editable line');
    const patch = { schemaVersion: 1, sourceHash: hash(bytes), op: 'TranslateEntities', ids: [entity.id], dx: 0, dy: 0, units: 'model-mm' };
    assert.deepEqual((await applyJwwPatch(bytes, patch)).bytes, bytes);
    const result = await applyJwwPatch(bytes, { ...patch, dx: 910 });
    const changed = result.ir.entities.find(e => e.id === entity.id);
    for (let i = 0; i < 4; i++) assert.ok(Math.abs(changed.points[i] - entity.points[i] - (i % 2 ? 0 : 910)) < 1e-7);
    const offset = result.receipt.changes[0].offset;
    assert.deepEqual(result.bytes.subarray(0, offset), bytes.subarray(0, offset));
    assert.deepEqual(result.bytes.subarray(offset + 32), bytes.subarray(offset + 32));
    assert.deepEqual(await readFile(process.env.FRESCO_JWW_FIXTURE), bytes);
  });
