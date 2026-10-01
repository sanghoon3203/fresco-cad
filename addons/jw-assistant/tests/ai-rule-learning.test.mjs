import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { summarizeExperience, ruleTextProblems, validateRulesDoc, distillRules, promoteRules, retireRules, ruleId, forbiddenStringsFrom, saveLearnedRules, loadLearnedRules, LEARNED_RULES_FILE } from '../ai/rule-learning.mjs';
import { createMockProvider } from '../eval/mock.mjs';

const attempt = (runId, n, extra = {}) => ({ type: 'attempt', runId, attempt: n, patterns: ['move', 'room'], provider: 'claude', model: 'claude-opus-5-5', toolCalls: [{ name: 'find_text' }], opKinds: ['translate'], validation: { ok: true }, error: null, ...extra });
const records = [
  attempt('r1', 1, { error: { code: 'E_PATCH_ENTITY' }, validation: { ok: false } }), attempt('r1', 2),
  { type: 'run', runId: 'r1', status: 'applied', attempts: 2, patterns: ['move', 'room'], language: 'ja' },
  attempt('r2', 1, { patterns: ['add-text'], opKinds: ['add:text'], patch: { ops: [{ op: 'add', entity: { kind: 'text', text: '山田様邸 新築工事' } }] } }),
  { type: 'run', runId: 'r2', status: 'applied', attempts: 1, patterns: ['add-text'], language: 'ko' },
  attempt('r3', 1, { error: { code: 'E_PATCH_ENTITY' } }), attempt('r3', 2, { error: { code: 'E_JWW_REWRITE_UNSAFE' } }),
  { type: 'run', runId: 'r3', status: 'failed', attempts: 2, patterns: ['delete'], language: 'ja' },
  { type: 'feedback', runId: 'r1', verdict: 'accepted' }
];
const doc = rules => ({ schemaVersion: 1, version: 1, rules });
const rule = (statement, patterns = ['move'], status = 'proposed') => ({ id: ruleId(statement), version: 1, statement_en: statement, statement_ja: '一般的な規則。', trigger: { patterns, errorCodes: [] },
  evidenceCount: 1, successRateBefore: null, successRateAfter: null, status });

test('summarizeExperience is deterministic and finds failure codes, patterns and fixes', () => {
  const a = summarizeExperience(records), b = summarizeExperience([...records].reverse());
  assert.deepEqual(a, b);
  assert.deepEqual(a.failureCodes[0], { key: 'E_PATCH_ENTITY', count: 2 });
  assert.equal(a.totals.runs, 3); assert.equal(a.totals.firstAttemptSuccessRate, 0.333);
  assert.equal(a.byPattern.move.applied, 1);
  assert.ok(a.fixes.some(f => f.key.startsWith('E_PATCH_ENTITY -> fixed')));
  assert.ok(a.fixes.some(f => f.key.startsWith('E_PATCH_ENTITY -> still-failing:E_JWW_REWRITE_UNSAFE')));
  assert.deepEqual(a.feedback, [{ key: 'accepted', count: 1 }]);
});

test('sanitizer rejects drawing contents: ids, coordinates, hashes, paths, file names, project texts', () => {
  const bad = ['Move e1234 by 300.', 'Place the text at (12500.5, -3200).', 'Hash de0ecf5991bbf7b66388a3837af2a231 is special.', 'Read C:/JWW/Test1.jww first.',
    'Anchor at 1439.830508 mm.', 'Use «T3» for the label.', 'See https://example.com.', 'Copy 山田様邸 新築工事 into the title.'];
  for (const s of bad) assert.ok(ruleTextProblems(s, { forbidden: ['山田様邸 新築工事'] }).length, s);
  for (const s of ['When widening a window, move both jamb lines; keep it on the 建具 layer.', '寝室の室名は室名レイヤに置く。', 'Use 910 mm modules for wooden plans.'])
    assert.deepEqual(ruleTextProblems(s, { forbidden: ['寝室', '山田様邸 新築工事'] }), [], s);
  assert.throws(() => validateRulesDoc(doc([{ ...rule('ok rule'), statement_ja: '座標 (100, 200) に置く' }])), e => e.code === 'E_RULE_UNSAFE');
  assert.throws(() => validateRulesDoc(doc([{ ...rule('ok rule'), status: 'live' }])), e => e.code === 'E_RULE_SCHEMA');
});

test('the versioned learned-rules.json in the repo is valid and contains no drawing contents', async () => {
  const current = await loadLearnedRules();
  validateRulesDoc(current);
  const raw = await readFile(LEARNED_RULES_FILE, 'utf8');
  // Distinctive strings from the corpus drawings used by eval tasks must never appear.
  for (const s of ['基準階平面図', '日影図ＴＥＳＴ用データ', '道路中心線', 'sourceHash', 'C:/JWW', '.jww']) assert.ok(!raw.includes(s), s);
  const tasks = (await readdir(new URL('../eval/tasks/', import.meta.url))).filter(n => n.endsWith('.json'));
  assert.ok(tasks.length >= 1);
  assert.ok(current.rules.every(r => r.status !== 'active' || (r.successRateAfter !== null && r.successRateAfter > r.successRateBefore)), 'active rules were promoted by an eval');
});

test('distillRules keeps safe generalized proposals, rejects unsafe ones without echoing them, merges duplicates', async () => {
  const safe = { statement_en: 'Before deleting a label, confirm with find_text that exactly one text matches; otherwise ask.', statement_ja: '削除前に一致する文字が一つか確認し、複数なら確認する。', patterns: ['delete', 'bogus'], errorCodes: ['E_PATCH_ENTITY', 'lower'], rationale: 'r' };
  const leaky = { statement_en: 'Put 山田様邸 新築工事 in the title block.', statement_ja: 'タイトル', patterns: ['add-text'], errorCodes: [], rationale: 'r' };
  const coords = { statement_en: 'Move entity e42 to (100, 200).', statement_ja: 'x', patterns: [], errorCodes: [], rationale: 'r' };
  const provider = createMockProvider({ script: Object.assign(() => null, { json: { rules: [safe, leaky, coords, safe] } }) });
  const out = await distillRules({ records, currentRules: doc([]), provider, now: () => new Date('2026-10-02T00:00:00Z') });
  assert.equal(out.accepted.length, 1);
  assert.equal(out.rejected.length, 2);
  assert.ok(!JSON.stringify(out.rejected).includes('山田'));
  const r = out.doc.rules[0];
  assert.deepEqual(r.trigger, { patterns: ['delete'], errorCodes: ['E_PATCH_ENTITY'] });
  assert.equal(r.status, 'proposed'); assert.equal(r.successRateBefore, null); assert.equal(r.evidenceCount, 2);
  assert.equal(out.doc.version, 2);
  assert.ok(forbiddenStringsFrom(records).includes('山田様邸 新築工事'));
  await assert.rejects(distillRules({ records, currentRules: doc([]), provider: {} }), e => e.code === 'E_RULE_PROVIDER');
});

test('promoteRules activates a rule only when the eval with it beats the eval without it', () => {
  const helps = rule('Confirm room labels with find_text before editing them.', ['change-text']);
  const neutral = rule('Prefer translate over delete and add when moving a label.', ['move']);
  const before = { tasks: [{ id: 'a#ja', patterns: ['change-text'], passed: false }, { id: 'b#ja', patterns: ['change-text'], passed: true }, { id: 'c#ja', patterns: ['move'], passed: true }, { id: 'd#ja', patterns: ['move'], passed: false, status: 'skipped' }] };
  const after = { rules: { included: [helps.id, neutral.id] }, tasks: [{ id: 'a#ja', patterns: ['change-text'], passed: true }, { id: 'b#ja', patterns: ['change-text'], passed: true }, { id: 'c#ja', patterns: ['move'], passed: true }, { id: 'd#ja', patterns: ['move'], passed: true, status: 'skipped' }] };
  const out = promoteRules({ rulesDoc: doc([helps, neutral]), evalBefore: before, evalAfter: after, now: () => new Date('2026-10-02T00:00:00Z') });
  assert.deepEqual(out.promoted, [helps.id]); assert.deepEqual(out.kept, [neutral.id]);
  const [h, n] = out.doc.rules;
  assert.deepEqual([h.status, h.version, h.successRateBefore, h.successRateAfter], ['active', 2, 0.5, 1]);
  assert.deepEqual([n.status, n.successRateBefore, n.successRateAfter], ['proposed', 1, 1]);
  const regress = promoteRules({ rulesDoc: doc([helps]), evalBefore: after, evalAfter: { ...before, rules: after.rules } });
  assert.deepEqual(regress.promoted, []);
  const retired = retireRules(out.doc, [h.id]);
  assert.equal(retired.rules[0].status, 'retired');
});

test('saveLearnedRules refuses documents with drawing data and writes valid ones', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fresco-rules-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'learned-rules.json');
  await assert.rejects(saveLearnedRules(doc([{ ...rule('Never move e17.') }]), file), e => e.code === 'E_RULE_UNSAFE');
  await saveLearnedRules(doc([rule('Keep moved labels on their original layer.')]), file);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).rules.length, 1);
});
