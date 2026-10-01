import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExperienceStore, attemptRecord, detectLanguage, classifyInstruction, sha256 } from '../ai/experience.mjs';

test('language detection and drawing-agnostic instruction tags', () => {
  assert.equal(detectLanguage('창문을 옮겨줘'), 'ko');
  assert.equal(detectLanguage('窓を移動して'), 'ja');
  assert.equal(detectLanguage('move it'), 'en');
  assert.deepEqual(classifyInstruction('和室の文字を右に300mm移動して'), ['move', 'room']);
  assert.ok(classifyInstruction('거실 글자를 LDK로 바꿔줘').includes('change-text'));
  assert.ok(classifyInstruction('塔屋の外形線を屋上レイヤに移して').includes('layer'));
  assert.ok(classifyInstruction('창문 좀 옮겨줘').includes('window'));
  assert.ok(!classifyInstruction('문자를 추가').includes('door'), '문자 (text) is not 문 (door)');
});

test('store appends JSONL per month, scrubs secrets, redacts instructions on request, tolerates a torn line', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fresco-exp-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { OPENAI_API_KEY: 'sk-proj-SECRETSECRETSECRET' };
  const store = createExperienceStore({ dir, env, redact: true, now: () => new Date('2026-10-01T12:00:00Z') });
  const rec = attemptRecord({ runId: 'r', attempt: 1, instruction: '洋室を削除 sk-proj-SECRETSECRETSECRET', sourceHash: 'h', provider: 'openai', model: 'gpt-5.2',
    contextStats: {}, toolCalls: [{ name: 'find_text', ok: true, count: 1, chars: 10, ms: 1, args: { query: 'secret query' } }], patch: { ops: [{ op: 'delete', ids: ['e1'] }, { op: 'add', entity: { kind: 'text' } }] },
    validation: { ok: true }, layerFindings: [], apply: null, latencyMs: 5, usage: {}, error: { code: 'E_X', detail: 'd' } });
  assert.equal(rec.instructionHash, sha256('洋室を削除 sk-proj-SECRETSECRETSECRET'));
  assert.deepEqual(rec.opKinds, ['delete', 'add:text']);
  assert.ok(!('args' in rec.toolCalls[0]), 'tool arguments are summarized, not stored');
  await store.append(rec);
  const file = path.join(dir, 'experience-2026-10.jsonl');
  await appendFile(file, '{"type":"attempt","torn');
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes('SECRETSECRET'));
  const all = await store.readAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].instruction, '[redacted]');
  assert.equal(all[0].schemaVersion, 1);
  assert.equal(all[0].ts, '2026-10-01T12:00:00.000Z');
  assert.deepEqual(await createExperienceStore({ dir: path.join(dir, 'none') }).readAll(), []);
  assert.throws(() => createExperienceStore({}), e => e.code === 'E_EXPERIENCE_DIR');
});
