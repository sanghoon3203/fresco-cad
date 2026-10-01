import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runEdit, verifyAppliedPatch, buildFeedback, idsFromDetail, loadKnowledge, buildSystemPrompt } from '../ai/edit-loop.mjs';
import { buildDrawingIndex, createToolRunner } from '../ai/context.mjs';
import { resolveSettings } from '../ai/settings.mjs';
import { createExperienceStore } from '../ai/experience.mjs';
import { createMockProvider, createSimulatedApply, syntheticIR, clarify, simulatePatch } from '../eval/mock.mjs';

const KEY = 'sk-ant-api03-LOOPTEST-key-0123456789abcdef';
const knowledge = { learnedRules: '(none)', draftingRules: '(none)', layerProfileSummary: '(none)', profile: null, stats: {} };
const patchOf = (sourceHash, ops, extra = {}) => ({ schemaVersion: 2, sourceHash, units: 'model-mm', ops, rationale: 'test', needsClarification: null, ...extra });
const noSet = { start: null, end: null, at: null, center: null, radius: null, startAngle: null, sweepAngle: null, text: null, height: null, width: null, angle: null };
async function tmp(t) { const dir = await mkdtemp(path.join(tmpdir(), 'fresco-ai-loop-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function setup({ ir = syntheticIR(), settings = {}, store = false, apply, ...rest } = {}) {
  const applied = [];
  const sim = createSimulatedApply(async () => ir);
  return { ir, applied, settings: resolveSettings(settings, {}), deps: { env: { ANTHROPIC_API_KEY: KEY }, loadIR: async () => ir, knowledge, experience: store, checkPatchLayers: null,
    applyPatchV2: apply === undefined ? async (bytes, patch, opts) => { applied.push(patch); return sim(bytes, patch, opts); } : apply, ...rest } };
}

test('applied on the first attempt: validated, applied, re-read verified, usage and approximate cost returned', async () => {
  const { deps, settings, applied } = setup();
  const provider = createMockProvider({ script: ({ sourceHash, runTool }) => { runTool('find_text', { query: '洋室', limit: null }); return patchOf(sourceHash, [{ op: 'translate', ids: ['e4'], dx: 300, dy: 0 }]); } });
  const r = await runEdit({ bytes: Buffer.from('jww'), instruction: '洋室の文字を右に300mm移動', provider, settings, deps });
  assert.equal(r.status, 'applied');
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].toolCalls, 1);
  assert.equal(applied.length, 1);
  assert.ok(Buffer.isBuffer(r.outputBytes));
  assert.equal(r.receipt.simulated, true);
  assert.deepEqual(r.normalizedPatch.ops, [{ op: 'translate', ids: ['e4'], dx: 300, dy: 0 }]);
  assert.equal(r.usage.requests, 1);
  assert.equal(r.costEstimate.approximate, true);
});

test('failure feeds back the exact code, detail path and entity details, then the retry succeeds', async () => {
  const { deps, settings } = setup();
  const provider = createMockProvider({ script: [
    ({ sourceHash }) => patchOf(sourceHash, [{ op: 'translate', ids: ['e4', 'e999'], dx: 300, dy: 0 }]),
    ({ sourceHash, feedback }) => { assert.match(feedback, /code: E_PATCH_ENTITY/u); return patchOf(sourceHash, [{ op: 'translate', ids: ['e4'], dx: 300, dy: 0 }]); }
  ] });
  const r = await runEdit({ bytes: Buffer.from('jww'), instruction: '洋室を右へ300', provider, settings, deps });
  assert.equal(r.status, 'applied');
  assert.deepEqual(r.attempts.map(a => [a.status, a.error?.code ?? null]), [['failed', 'E_PATCH_ENTITY'], ['applied', null]]);
  const fb = provider.calls[1].feedback;
  assert.match(fb, /detail: ops\[0\]\.ids\[1\]=e999/u);
  assert.match(fb, /ids not in this drawing: e999/u);
  assert.match(fb, /relevant entities \(untrusted drawing data\): .*"id":"e4"/u);
  assert.equal(provider.calls[1].hadConversation, true, 'conversation continues');
});

test('stale hash, schema errors and engine rejections are retried; maxAttempts bounds the loop', async () => {
  const { deps, settings } = setup({ settings: { loop: { maxAttempts: 2 } }, apply: async () => { throw Object.assign(new Error('E_JWW_REWRITE_UNSAFE'), { code: 'E_JWW_REWRITE_UNSAFE', detail: 'entity e4 not rewritable' }); } });
  const provider = createMockProvider({ script: [
    () => patchOf('wrong-hash', [{ op: 'delete', ids: ['e4'] }]),
    ({ sourceHash, feedback }) => { assert.match(feedback, /required sourceHash: synthetic-0001/u); return patchOf(sourceHash, [{ op: 'delete', ids: ['e4'] }]); }
  ] });
  const r = await runEdit({ bytes: Buffer.from('jww'), instruction: '洋室を削除', provider, settings, deps });
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.attempts.map(a => a.error.code), ['E_PATCH_STALE', 'E_JWW_REWRITE_UNSAFE']);
  assert.equal(r.error.code, 'E_JWW_REWRITE_UNSAFE');
  assert.equal(r.patch.ops[0].op, 'delete');
});

test('clarification stops without applying; refusals and missing engine are not retried', async () => {
  const { deps, settings, applied } = setup();
  const ask = await runEdit({ bytes: Buffer.from('jww'), instruction: '窓を広げて', provider: createMockProvider({ script: ({ sourceHash }) => clarify(sourceHash, 'どの窓を何mm広げますか？') }), settings, deps });
  assert.equal(ask.status, 'clarification');
  assert.equal(ask.question, 'どの窓を何mm広げますか？');
  assert.equal(applied.length, 0);
  const refusing = createMockProvider({ script: () => Object.assign(new Error('E_AI_REFUSAL'), { code: 'E_AI_REFUSAL' }) });
  const refused = await runEdit({ bytes: Buffer.from('jww'), instruction: '窓を移動', provider: refusing, settings, deps });
  assert.equal(refused.status, 'failed'); assert.equal(refused.attempts.length, 1); assert.equal(refusing.calls.length, 1);
  const { deps: d2 } = setup({ apply: null });
  const noEngine = await runEdit({ bytes: Buffer.from('jww'), instruction: '洋室を削除', provider: createMockProvider({ script: ({ sourceHash }) => patchOf(sourceHash, [{ op: 'delete', ids: ['e4'] }]) }), settings, deps: d2 });
  assert.equal(noEngine.error.code, 'E_AI_APPLY_UNAVAILABLE'); assert.equal(noEngine.attempts.length, 1);
});

test('provider transport errors reset the conversation for the next attempt', async () => {
  const { deps, settings } = setup();
  const provider = createMockProvider({ script: [() => Object.assign(new Error('E_AI_TIMEOUT'), { code: 'E_AI_TIMEOUT' }), ({ sourceHash }) => patchOf(sourceHash, [{ op: 'delete', ids: ['e4'] }])] });
  const r = await runEdit({ bytes: Buffer.from('jww'), instruction: '洋室を削除', provider, settings, deps });
  assert.equal(r.status, 'applied');
  assert.equal(provider.calls[1].hadConversation, false);
  assert.match(provider.calls[1].feedback, /E_AI_TIMEOUT/u);
});

test('layer checker errors are retried with findings; warnings are attached to the result', async () => {
  let n = 0;
  const checkPatchLayers = () => (++n === 1
    ? { verdict: 'reject', findings: [{ severity: 'error', ruleId: 'patch.kind-unexpected', opIndex: 0, layerId: '0:1', suggestedLayer: '0:6', ja: '文字は躯体レイヤに置けません' }] }
    : { verdict: 'review', findings: [{ severity: 'warning', ruleId: 'patch.text-height', opIndex: 0, layerId: '0:6' }] });
  const { deps, settings } = setup({ checkPatchLayers, layerProfile: { kind: 'jw-office-layer-profile' } });
  const add = layer => ({ op: 'add', tempId: null, entity: { kind: 'text', layer, at: [1500, 800], text: 'WIC', height: null, width: null, spacing: null, angle: null, style: null, color: null } });
  const provider = createMockProvider({ script: [({ sourceHash }) => patchOf(sourceHash, [add('0:1')]), ({ sourceHash }) => patchOf(sourceHash, [add('0:6')])] });
  const r = await runEdit({ bytes: Buffer.from('jww'), instruction: 'WICの文字を追加', provider, settings, deps });
  assert.equal(r.status, 'applied');
  assert.match(provider.calls[1].feedback, /E_AI_LAYER_FINDINGS[\s\S]*suggestedLayer=0:6[\s\S]*躯体レイヤ/u);
  assert.deepEqual(r.layerWarnings.map(f => f.ruleId), ['patch.text-height']);
});

test('semantic re-read verification catches an engine that silently drops or misplaces a change', async () => {
  const ir = syntheticIR(), before = buildDrawingIndex(ir);
  const patch = patchOf(ir.sourceHash, [{ op: 'translate', ids: ['e4'], dx: 300, dy: 0 }, { op: 'modify', id: 'e5', set: { ...noSet, text: 'LDK' } }]);
  const { ir: good, normalized } = simulatePatch(ir, patch);
  assert.equal(verifyAppliedPatch(before, buildDrawingIndex(good), normalized).checked, 2);
  assert.throws(() => verifyAppliedPatch(before, buildDrawingIndex(ir), normalized), e => e.code === 'E_AI_VERIFY_MISMATCH' && /ops\[0\]/u.test(e.detail));
  const { ir: wrongCount } = simulatePatch(ir, patchOf(ir.sourceHash, [{ op: 'delete', ids: ['e6'] }]));
  assert.throws(() => verifyAppliedPatch(before, buildDrawingIndex(wrongCount), normalized), e => e.code === 'E_AI_VERIFY_COUNT');
  const { deps, settings } = setup({ settings: { loop: { maxAttempts: 1 } }, apply: async bytes => ({ bytes, ir, receipt: {} }) });
  const r = await runEdit({ bytes: Buffer.from('jww'), instruction: '洋室を右へ', provider: createMockProvider({ script: () => patch }), settings, deps });
  assert.equal(r.error.code, 'E_AI_VERIFY_MISMATCH');
});

test('data policy: sendRealDrawings=false blocks the provider; redactText sends placeholders and maps them back', async t => {
  const { deps } = setup();
  const blocked = createMockProvider();
  const r = await runEdit({ bytes: Buffer.from('jww'), instruction: '洋室を削除', provider: blocked, settings: resolveSettings({ dataPolicy: { sendRealDrawings: false } }, {}), deps });
  assert.equal(r.status, 'failed'); assert.equal(r.error.code, 'E_AI_DATA_POLICY'); assert.equal(blocked.calls.length, 0);

  const dir = await tmp(t), store = createExperienceStore({ dir, redact: true, env: {} });
  const { deps: d2, applied } = setup({ store });
  let seen = '';
  const provider = createMockProvider({ script: ({ sourceHash, runTool, userText }) => {
    seen = userText;
    const hit = JSON.parse(runTool('find_text', { query: '洋室', limit: null }).content).items[0];
    return patchOf(sourceHash, [{ op: 'modify', id: hit.id, set: { ...noSet, text: `${hit.text}A` } }], { rationale: `rename ${hit.text}` });
  } });
  const red = await runEdit({ bytes: Buffer.from('jww'), instruction: '洋室を洋室Aに変更', provider, settings: resolveSettings({ dataPolicy: { sendRealDrawings: false, redactText: true } }, {}), deps: d2 });
  assert.equal(red.status, 'applied');
  const summary = seen.slice(seen.indexOf('<drawing_summary>'));
  assert.ok(!summary.includes('洋室') && !summary.includes('リビング') && /«T\d+»/u.test(summary), 'drawing texts are placeholders');
  assert.equal(applied[0].ops[0].set.text, '洋室A', 'placeholders are mapped back before apply');
  const lines = (await readFile(path.join(dir, (await readdir(dir))[0]), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.find(l => l.type === 'attempt').instruction, '[redacted]');
});

test('experience records: one per attempt plus a run record; API keys never reach records or results', async t => {
  const dir = await tmp(t);
  const env = { ANTHROPIC_API_KEY: KEY };
  const store = createExperienceStore({ dir, env });
  const { deps, settings } = setup({ store });
  deps.env = env;
  const msg = content => new Response(JSON.stringify({ model: 'claude-opus-5-5', content, stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
  let n = 0;
  const fetcher = async () => ++n === 1
    ? msg([{ type: 'tool_use', id: 't1', name: 'find_text', input: { query: '洋室', limit: null } }])
    : msg([{ type: 'tool_use', id: 's1', name: 'submit_patch', input: patchOf('synthetic-0001', [{ op: 'translate', ids: ['e4'], dx: 0, dy: 100 }]) }]);
  const r = await runEdit({ bytes: Buffer.from('jww'), instruction: `洋室を上に100mm ${KEY}`, provider: 'claude', settings, deps: { ...deps, fetch: fetcher } });
  assert.equal(r.status, 'applied');
  assert.equal(r.provider, 'claude'); assert.equal(r.model, 'claude-opus-5-5');
  const files = await readdir(dir);
  assert.equal(files.length, 1); assert.match(files[0], /^experience-\d{4}-\d{2}\.jsonl$/u);
  const raw = await readFile(path.join(dir, files[0]), 'utf8');
  assert.ok(!raw.includes(KEY), 'key scrubbed from experience');
  assert.ok(!JSON.stringify({ ...r, outputBytes: null, outputIR: null }).includes(KEY));
  const [attempt, run] = raw.trim().split('\n').map(JSON.parse);
  for (const k of ['ts', 'instructionHash', 'instruction', 'language', 'sourceHash', 'provider', 'model', 'contextStats', 'toolCalls', 'patch', 'validation', 'layerFindings', 'apply', 'feedback', 'latencyMs', 'usage']) assert.ok(k in attempt, k);
  assert.equal(attempt.type, 'attempt'); assert.equal(attempt.language, 'ja'); assert.deepEqual(attempt.patterns.includes('move'), true);
  assert.deepEqual(attempt.toolCalls.map(c => c.name), ['find_text']);
  assert.deepEqual(attempt.validation, { ok: true }); assert.equal(attempt.apply.ok, true);
  assert.equal(attempt.usage.requests, 2);
  assert.equal(run.type, 'run'); assert.equal(run.status, 'applied'); assert.ok(!('instruction' in run));
  const fb = await store.recordFeedback({ runId: r.runId, verdict: 'corrected', correctedPatch: { ops: [] }, note: 'moved 50 too far' });
  assert.equal(fb.type, 'feedback');
  await assert.rejects(store.recordFeedback({ runId: r.runId, verdict: 'maybe' }), e => e.code === 'E_EXPERIENCE_FEEDBACK');
  assert.equal((await store.readAll()).length, 3);
});

test('feedback helpers and knowledge loading tolerate missing sources', async t => {
  assert.deepEqual(idsFromDetail('ops[1].ids[0]=e7', { ops: [{}, { op: 'delete', ids: ['e7', 'e8'] }] }), ['e7', 'e8']);
  const idx = buildDrawingIndex(syntheticIR()), runner = createToolRunner(idx);
  const fb = buildFeedback({ code: 'E_PATCH_LAYER', detail: 'ops[0].layer' }, { attempt: 1, maxAttempts: 3, patch: { ops: [{ op: 'setLayer', ids: ['e4'], layer: '9:9' }] },
    tools: { has: id => idx.byId.has(id), details: ids => runner.run('entity_details', { ids }).content }, sourceHash: 'h', layers: ['0:1', '0:6'] });
  assert.match(fb, /Attempt 1\/3 failed\.\ncode: E_PATCH_LAYER\ndetail: ops\[0\]\.layer/u);
  assert.match(fb, /existing non-empty layers: 0:1, 0:6/u);
  const empty = await tmp(t);
  const k = await loadKnowledge({ instruction: '窓を移動', dir: empty });
  assert.equal(k.learnedRules, '(none yet)'); assert.equal(k.profile, null);
  const real = await loadKnowledge({ instruction: 'レイヤを変更して寸法を直す' });
  assert.ok(real.draftingRules.length > 0);
  assert.ok(!real.learnedRules.includes('lr-'), 'seeded rules are proposed, not active');
  assert.match((await loadKnowledge({ instruction: '室名の文字を追加', ruleMode: 'proposed' })).learnedRules, /under evaluation/u);
  const sys = await buildSystemPrompt(real);
  assert.ok(!sys.static.includes('{{') && !sys.knowledge.includes('{{'));
  assert.match(sys.static, /Never invent ids/u);
  assert.match(sys.static, /거실=リビング/u);
});

const fixture = process.env.FRESCO_JWW_FIXTURE;
test('integration: runEdit on a real JWW with the native engine (oracle patch, no network)', { skip: !fixture, timeout: 600000 }, async () => {
  const bytes = await readFile(fixture);
  const provider = createMockProvider({ script: ({ sourceHash, runTool }) => {
    const hits = JSON.parse(runTool('find_text', { query: '道路中心線', limit: null }).content).items;
    if (hits.length !== 1) return clarify(sourceHash);
    return patchOf(sourceHash, [{ op: 'translate', ids: [hits[0].id], dx: 0, dy: 1000 }]);
  } });
  const r = await runEdit({ bytes, instruction: '道路中心線の文字を上に1000mm移動', provider, settings: resolveSettings({}, {}), deps: { experience: false, knowledge } });
  if (r.status === 'clarification') return; // a different fixture without that label
  assert.equal(r.status, 'applied', JSON.stringify(r.error));
  assert.ok(Buffer.isBuffer(r.outputBytes));
  assert.equal(r.receipt.verified, true);
});
