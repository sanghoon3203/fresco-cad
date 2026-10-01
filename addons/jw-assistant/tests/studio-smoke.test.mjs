import test from 'node:test';
import assert from 'node:assert/strict';
import { patchLine, observeRules } from '../native/jww.mjs';
import { generateRules, classifyLayers } from '../ai/providers.mjs';
import { layerCategories } from '../field/standards.mjs';

test('line edit changes only coordinate bytes and refuses ambiguous matches', () => {
  const record = Buffer.alloc(47); record.writeInt32LE(15); [1, 2, 3, 4].forEach((v, i) => record.writeDoubleLE(v, 15 + i * 8));
  const document = { version: 700, entities: [{ id: 'e0', type: 'JwwSen', props: { m_lGroup: 0, m_sFlg: 0 }, record: record.toString('base64') }] };
  const input = Buffer.concat([Buffer.alloc(19, 41), record, Buffer.alloc(23, 99)]), original = Buffer.from(input);
  const result = patchLine(input, document, 'e0', [1, 2, 30, 40]);
  assert.deepEqual(input, original); assert.deepEqual(result.bytes.subarray(0, 34), original.subarray(0, 34));
  assert.deepEqual(result.bytes.subarray(66), original.subarray(66)); assert.equal(result.bytes.readDoubleLE(50), 30);
  assert.throws(() => patchLine(Buffer.concat([record, record]), document, 'e0', [1, 2, 3, 4]), { code: 'E_JWW_AMBIGUOUS_RECORD' });
  assert.throws(() => patchLine(input, document, 'e0', [1, NaN, 3, 4]), { code: 'E_JWW_COORDINATES' });
});
test('observed rules retain source evidence and remain proposals', () => {
  const result = observeRules({ entities: [{ id: 'e0', type: 'JwwSen', props: { m_nGLayer: 0, m_nLayer: 1, m_nPenColor: 2, m_nPenStyle: 1 } }], layers: [{ id: '0:1', name: 'Test', scale: 50 }] }, 'source-hash');
  assert.equal(result.candidates[0].status, 'proposal'); assert.equal(result.candidates[0].evidenceCount, 1);
  assert.deepEqual(result.candidates[0].allowedColors, [2]); assert.equal(result.sourceHash, 'source-hash');
});
const context = { layers: [{ id: '0:1', name: 'Synthetic wall example' }] };
test('OpenAI request uses explicit endpoint, nonstored structured output and validates referenced layer', async () => {
  let request;
  const fetcher = async (url, options) => { request = JSON.parse(options.body); assert.equal(url, 'https://api.openai.com/v1/responses');
    return { ok: true, text: async () => JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: 'Example', proposals: [{ layerId: '0:1', categoryId: 'unknown', reason: 'Not enough evidence', needsConfirmation: true }] }) }] }] }) }; };
  const result = await generateRules(context, { key: 'synthetic-key', model: 'test-model', fetcher });
  assert.equal(request.store, false); assert.equal(request.text.format.strict, true); assert.equal(result.proposals[0].needsConfirmation, true);
  await assert.rejects(generateRules(context, { key: '', model: 'test-model', fetcher }), { code: 'E_AI_KEY_REQUIRED' });
});
test('Jev only returns known classes and validates probability distribution', async () => {
  const probabilities = Object.fromEntries([...layerCategories.map(item => item.id), 'unknown'].map(id => [id, id === 'unknown' ? 1 : 0]));
  const fetcher = async (url, options) => { assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(JSON.parse(options.body).questions.layer_0.type, 'choice');
    return { ok: true, text: async () => JSON.stringify({ answers: { layer_0: { type: 'choice', choice: 'unknown', confidence: 1, probabilities } } }) }; };
  assert.equal((await classifyLayers(context, { key: 'synthetic-key', fetcher })).proposals[0].categoryId, 'unknown');
  probabilities.unknown = 2; await assert.rejects(classifyLayers(context, { key: 'synthetic-key', fetcher }), { code: 'E_AI_RESPONSE' });
});
