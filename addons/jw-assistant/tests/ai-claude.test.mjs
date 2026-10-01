import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeProvider, claudeTraits, toStrictToolSchema } from '../ai/claude.mjs';
import { resolveSettings } from '../ai/settings.mjs';
import { patchV2JsonSchema } from '../core/patch-v2.mjs';

const KEY = 'sk-ant-api03-TEST-claude-key-0000000000';
const env = { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'https://must-not-be-used.example' };
const settings = resolveSettings({});
const system = { static: 'STATIC PROMPT', knowledge: 'KNOWLEDGE BLOCK' };
const patch = { schemaVersion: 2, sourceHash: 'h', units: 'model-mm', ops: [], rationale: 'r', needsClarification: 'どの窓ですか？' };
const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 };
const msg = (content, stop_reason = 'tool_use', extra = {}) => ({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, usage, ...extra });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

function mockFetch(replies) {
  const requests = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, headers: init.headers, body: structuredClone(body) });
    const r = replies[Math.min(requests.length - 1, replies.length - 1)];
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(typeof r === 'function' ? r(body) : r), { status: 200 });
  };
  return { fetcher, requests };
}
const runner = () => { const calls = []; return { calls, run: (name, args) => { calls.push({ name, args }); return { ok: true, content: JSON.stringify({ tool: name, items: [] }) }; } }; };

test('traits: Opus 5.5 rejects forced tool_choice, uses adaptive thinking and server fallback; strict schema drops array bounds', () => {
  assert.deepEqual(claudeTraits('claude-opus-5-5'), { adaptiveThinking: true, forcedToolChoice: false, serverFallback: true });
  assert.equal(claudeTraits('claude-haiku-4-5-20251001').adaptiveThinking, false);
  assert.equal(claudeTraits('claude-haiku-4-5-20251001').forcedToolChoice, true);
  assert.ok(!JSON.stringify(toStrictToolSchema(patchV2JsonSchema)).includes('minItems'));
});

test('tool-use loop: read tools run, then submit_patch ends the attempt; request shape and caching are correct', async () => {
  const { fetcher, requests } = mockFetch([
    msg([{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'looking' }, toolUse('t1', 'find_text', { query: '窓', limit: null }), toolUse('t2', 'layer_summary', { layerId: '0:3' })]),
    msg([toolUse('s1', 'submit_patch', patch)])
  ]);
  const p = createClaudeProvider({ settings, env, fetcher }), tools = runner();
  const out = await p.propose({ system, userText: 'USER', runTool: tools.run, maxToolCalls: 5 });
  assert.deepEqual(out.patch, patch);
  assert.equal(out.toolCalls, 2);
  assert.deepEqual(tools.calls.map(c => c.name), ['find_text', 'layer_summary']);
  assert.deepEqual(out.usage, { inputTokens: 200, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 10, requests: 2 });
  const [first, second] = requests;
  assert.equal(first.url, 'https://api.anthropic.com/v1/messages', 'ANTHROPIC_BASE_URL is ignored');
  assert.equal(first.headers['x-api-key'], KEY);
  assert.equal(first.headers['anthropic-version'], '2023-06-01');
  assert.equal(first.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(first.body.model, 'claude-opus-5-5');
  assert.deepEqual(first.body.thinking, { type: 'adaptive' });
  assert.equal(first.body.output_config.effort, 'high');
  assert.equal(first.body.fallbacks, 'default');
  assert.deepEqual(first.body.tool_choice, { type: 'auto' });
  assert.ok(!('temperature' in first.body) && !('top_p' in first.body));
  assert.deepEqual(first.body.system.map(b => [b.text, b.cache_control?.type]), [['STATIC PROMPT', 'ephemeral'], ['KNOWLEDGE BLOCK', 'ephemeral']]);
  assert.deepEqual(first.body.cache_control, { type: 'ephemeral' });
  const submit = first.body.tools.find(t => t.name === 'submit_patch');
  assert.equal(submit.strict, true);
  assert.equal(first.body.tools.length, 7);
  // Append-only: the assistant turn (incl. thinking) is replayed unchanged; both tool_results in ONE user message.
  assert.equal(second.body.messages.length, 3);
  assert.deepEqual(second.body.messages[1].content[0], { type: 'thinking', thinking: '', signature: 'sig' });
  assert.deepEqual(second.body.messages[2].content.map(b => [b.type, b.tool_use_id]), [['tool_result', 't1'], ['tool_result', 't2']]);
  assert.ok(!JSON.stringify(out).includes(KEY), 'result never contains the key');
});

test('retry feedback is delivered as the error tool_result of the pending submit_patch', async () => {
  const { fetcher, requests } = mockFetch([msg([toolUse('s1', 'submit_patch', patch), toolUse('t9', 'find_text', { query: 'x', limit: null })]), msg([toolUse('s2', 'submit_patch', patch)])]);
  const p = createClaudeProvider({ settings, env, fetcher });
  const first = await p.propose({ system, userText: 'USER', runTool: runner().run });
  const second = await p.propose({ system, userText: 'USER', runTool: runner().run, conversation: first.conversation, feedback: 'code: E_PATCH_ENTITY' });
  assert.equal(second.patch.rationale, 'r');
  const last = requests[1].body.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.deepEqual(last.content.map(b => [b.tool_use_id, b.is_error, b.content]),
    [['t9', true, 'Not executed: submit_patch was called in the same turn.'], ['s1', true, 'code: E_PATCH_ENTITY']]);
});

test('refusal, max_tokens and context overflow map to stable codes', async () => {
  for (const [stop, codeName, extra] of [['refusal', 'E_AI_REFUSAL', { stop_details: { type: 'refusal', category: 'cyber' } }], ['max_tokens', 'E_AI_MAX_TOKENS', {}], ['model_context_window_exceeded', 'E_AI_CONTEXT_LIMIT', {}]]) {
    const { fetcher } = mockFetch([msg([{ type: 'text', text: '' }], stop, extra)]);
    await assert.rejects(createClaudeProvider({ settings, env, fetcher }).propose({ system, userText: 'U', runTool: runner().run }),
      e => e.code === codeName && (stop !== 'refusal' || e.detail === 'cyber') && (stop === 'refusal' || e.resetConversation === true));
  }
  const { fetcher } = mockFetch([{ id: 'x', content: 'not-an-array' }]);
  await assert.rejects(createClaudeProvider({ settings, env, fetcher }).propose({ system, userText: 'U', runTool: runner().run }), e => e.code === 'E_AI_RESPONSE');
});

test('end_turn without submission is nudged once, then fails with E_AI_NO_SUBMISSION', async () => {
  const { fetcher, requests } = mockFetch([msg([{ type: 'text', text: 'done?' }], 'end_turn')]);
  await assert.rejects(createClaudeProvider({ settings, env, fetcher }).propose({ system, userText: 'U', runTool: runner().run }), e => e.code === 'E_AI_NO_SUBMISSION' && !!e.conversation);
  assert.equal(requests.length, 2);
  assert.match(requests[1].body.messages.at(-1).content[0].text, /submit_patch/u);
});

test('tool budget: extra read calls get an error result plus a submit instruction (no forced tool_choice on Opus 5.5)', async () => {
  const { fetcher, requests } = mockFetch([
    msg([toolUse('a', 'find_text', { query: 'a', limit: null }), toolUse('b', 'find_text', { query: 'b', limit: null })]),
    msg([toolUse('s', 'submit_patch', patch)])
  ]);
  const tools = runner();
  const out = await createClaudeProvider({ settings, env, fetcher }).propose({ system, userText: 'U', runTool: tools.run, maxToolCalls: 1 });
  assert.equal(out.toolCalls, 1);
  assert.equal(tools.calls.length, 1);
  const results = requests[1].body.messages.at(-1).content;
  assert.equal(results[1].is_error, true);
  assert.match(results.at(-1).text, /Tool budget exhausted/u);
  assert.deepEqual(requests[1].body.tool_choice, { type: 'auto' });
  // A model that accepts forced tool use (and has no adaptive thinking) is forced to submit.
  const haiku = mockFetch([msg([toolUse('a', 'find_text', { query: 'a', limit: null })]), msg([toolUse('s', 'submit_patch', patch)])]);
  await createClaudeProvider({ settings, env, fetcher: haiku.fetcher, model: 'claude-haiku-4-5-20251001' }).propose({ system, userText: 'U', runTool: runner().run, maxToolCalls: 1 });
  assert.deepEqual(haiku.requests[1].body.tool_choice, { type: 'tool', name: 'submit_patch' });
  assert.ok(!('thinking' in haiku.requests[0].body) && !('fallbacks' in haiku.requests[0].body));
});

test('unknown tools get an error result; a strict-schema 400 falls back to a plain schema once', async () => {
  const strict400 = new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'tools.6.strict: schema not supported' } }), { status: 400 });
  const { fetcher, requests } = mockFetch([strict400, msg([toolUse('u', 'rm_rf', {})]), msg([toolUse('s', 'submit_patch', patch)])]);
  const out = await createClaudeProvider({ settings, env, fetcher }).propose({ system, userText: 'U', runTool: runner().run });
  assert.deepEqual(out.patch, patch);
  assert.equal(requests[1].body.tools.at(-1).strict, undefined);
  assert.match(requests[2].body.messages.at(-1).content[0].content, /Unknown tool/u);
});

test('missing key fails before any request; HTTP errors never leak the key; fast model and base URL override', async () => {
  const { fetcher, requests } = mockFetch([msg([toolUse('s', 'submit_patch', patch)])]);
  await assert.rejects(createClaudeProvider({ settings, env: {}, fetcher }).propose({ system, userText: 'U', runTool: runner().run }), e => e.code === 'E_AI_KEY_REQUIRED');
  assert.equal(requests.length, 0);
  const bad = mockFetch([new Response(JSON.stringify({ error: { type: 'authentication_error', message: `bad key ${KEY}` } }), { status: 401 })]);
  await assert.rejects(createClaudeProvider({ settings, env, fetcher: bad.fetcher }).propose({ system, userText: 'U', runTool: runner().run }),
    e => e.code === 'E_AI_HTTP_401' && !e.message.includes(KEY));
  const fast = mockFetch([msg([toolUse('s', 'submit_patch', patch)])]);
  const p = createClaudeProvider({ settings, env: { ...env, FRESCO_ANTHROPIC_BASE_URL: 'https://gateway.example' }, fetcher: fast.fetcher, fast: true });
  await p.propose({ system, userText: 'U', runTool: runner().run });
  assert.equal(fast.requests[0].body.model, 'claude-sonnet-5-5');
  assert.equal(fast.requests[0].url, 'https://gateway.example/v1/messages');
});

test('completeJson uses output_config.format json_schema and parses the text block', async () => {
  const { fetcher, requests } = mockFetch([msg([{ type: 'text', text: '{"rules":[]}' }], 'end_turn')]);
  const out = await createClaudeProvider({ settings, env, fetcher }).completeJson({ system: 'S', user: 'U', schema: { type: 'object', additionalProperties: false, required: ['rules'], properties: { rules: { type: 'array', items: { type: 'string' }, maxItems: 3 } } } });
  assert.deepEqual(out.value, { rules: [] });
  assert.equal(requests[0].body.output_config.format.type, 'json_schema');
  assert.ok(!JSON.stringify(requests[0].body.output_config.format.schema).includes('maxItems'));
  const broken = mockFetch([msg([{ type: 'text', text: '{oops' }], 'end_turn')]);
  await assert.rejects(createClaudeProvider({ settings, env, fetcher: broken.fetcher }).completeJson({ system: 'S', user: 'U', schema: {} }), e => e.code === 'E_AI_MALFORMED_JSON');
});
