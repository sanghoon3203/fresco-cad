import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePatchV2, patchV2JsonSchema } from '../core/patch-v2.mjs';

const ir = { sourceHash: 'h', layers: [{ id: '0:0' }, { id: '0:3' }], entities: [{ id: 'e0' }, { id: 'e1' }] };
const base = ops => ({ schemaVersion: 2, sourceHash: 'h', units: 'model-mm', ops, rationale: 'r', needsClarification: null });
const pen = { color: 1, style: 1, width: null };
const noSet = { start: null, end: null, at: null, center: null, radius: null, startAngle: null, sweepAngle: null, text: null, height: null, width: null, angle: null };
const code = c => err => err.code === c;

test('patch v2 normalizes strict-schema nulls and resolves temp IDs', () => {
  const out = validatePatchV2(base([
    { op: 'add', tempId: 'n0', entity: { kind: 'line', layer: '0:3', start: [0, 0], end: [910, 0], pen } },
    { op: 'translate', ids: ['n0', 'e1'], dx: 455, dy: 0 },
    { op: 'modify', id: 'e0', set: { ...noSet, end: [1820, 0] } },
    { op: 'add', tempId: null, entity: { kind: 'text', layer: '0:0', at: [0, 0], text: '洋室', height: null, width: null, spacing: null, angle: null, style: 3, color: null } }
  ]), ir);
  assert.deepEqual(out.ops[0], { op: 'add', tempId: 'n0', entity: { kind: 'line', layer: '0:3', start: [0, 0], end: [910, 0], pen: { color: 1, style: 1 } } });
  assert.deepEqual(out.ops[2].set, { end: [1820, 0] });
  assert.deepEqual(out.ops[3].entity, { kind: 'text', layer: '0:0', at: [0, 0], text: '洋室', style: 3 });
});

test('patch v2 rejects stale, unknown, deleted and malformed targets with paths', () => {
  assert.throws(() => validatePatchV2({ ...base([{ op: 'delete', ids: ['e0'] }]), sourceHash: 'x' }, ir), code('E_PATCH_STALE'));
  assert.throws(() => validatePatchV2(base([{ op: 'delete', ids: ['e9'] }]), ir), err => err.code === 'E_PATCH_ENTITY' && /ops\[0\]\.ids\[0\]=e9/u.test(err.message));
  assert.throws(() => validatePatchV2(base([{ op: 'delete', ids: ['e0'] }, { op: 'translate', ids: ['e0'], dx: 1, dy: 0 }]), ir), code('E_PATCH_DELETED_TARGET'));
  assert.throws(() => validatePatchV2(base([{ op: 'setLayer', ids: ['e0'], layer: '1:0' }]), ir), code('E_PATCH_LAYER'));
  assert.throws(() => validatePatchV2(base([{ op: 'add', tempId: null, entity: { kind: 'line', layer: '0:0', start: [1, 1], end: [1, 1], pen } }]), ir), code('E_PATCH_ZERO_LENGTH'));
  assert.throws(() => validatePatchV2(base([{ op: 'translate', ids: ['e0'], dx: Infinity, dy: 0 }]), ir), code('E_PATCH_VALUE'));
  assert.throws(() => validatePatchV2(base([{ op: 'modify', id: 'e0', set: noSet }]), ir), code('E_PATCH_EMPTY'));
  assert.throws(() => validatePatchV2(base([{ op: 'drop', ids: ['e0'] }]), ir), code('E_PATCH_SCHEMA'));
  assert.throws(() => validatePatchV2(base([]), ir), code('E_PATCH_EMPTY'));
});

test('patch v2 allows a clarification-only answer and exposes a strict schema', () => {
  assert.equal(validatePatchV2({ ...base([]), needsClarification: 'どの窓ですか？' }, ir).ops.length, 0);
  const walk = s => { if (s?.type === 'object') { assert.equal(s.additionalProperties, false); assert.deepEqual(s.required, Object.keys(s.properties)); Object.values(s.properties).forEach(walk); }
    if (s?.items) walk(s.items); (s?.anyOf ?? []).forEach(walk); };
  walk(patchV2JsonSchema);
});
