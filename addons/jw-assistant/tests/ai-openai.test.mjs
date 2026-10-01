import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIProvider } from '../ai/openai.mjs';
import { resolveSettings } from '../ai/settings.mjs';

const KEY = 'sk-proj-TESTOPENAIKEY0123456789';
const env = { OPENAI_API_KEY: KEY };
const settings = resolveSettings({});
const system = { static: 'STATIC', knowledge: 'KNOW' };
const patch = { schemaVersion: 2, sourceHash: 'h', units: 'model-mm', ops: [], rationale: 'r', needsClarification: 'which?' };
const usage = { input_tokens: 120, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30 };
const reply = (output, extra = {}) => ({ id: 'resp', status: 'completed', model: 'gpt-5.2', output, usage, ...extra });
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
function mockFetch(replies) {
  const requests = [];
  return { requests, fetcher: async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(replies[Math.min(requests.length - 1, replies.length - 1)]), { status: 200 });
  } };
}
const tools = () => { const calls = []; return { calls, run: (name, args) => { calls.push({ name, args }); return { ok: true, content: '{"items":[]}' }; } }; };

test('function tools then strict json_schema final answer; store:false; reasoning items replayed', async () => {
  const { fetcher, requests } = mockFetch([
    reply([{ type: 'reasoning', id: 'rs1', encrypted_content: 'enc' }, call('c1', 'find_text', { query: '窓', limit: null }), call('c2', 'entity_details', '{bad json')]),
    reply([message(JSON.stringify(patch))])
  ]);
  const t = tools(), out = await createOpenAIProvider({ settings, env, fetcher }).propose({ system, userText: 'USER', runTool: t.run, maxToolCalls: 5 });
  assert.deepEqual(out.patch, patch);
  assert.deepEqual(t.calls.map(c => c.name), ['find_text']);
  assert.deepEqual(out.usage, { inputTokens: 200, outputTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 0, requests: 2 });
  const [a, b] = requests;
  assert.equal(a.url, 'https://api.openai.com/v1/responses');
  assert.equal(a.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(a.body.store, false);
  assert.equal(a.body.instructions, 'STATIC\n\nKNOW');
  assert.equal(a.body.text.format.type, 'json_schema');
  assert.equal(a.body.text.format.strict, true);
  assert.ok(a.body.tools.every(x => x.type === 'function' && x.strict === true));
  assert.deepEqual(a.body.include, ['reasoning.encrypted_content']);
  assert.ok(!('temperature' in a.body));
  assert.deepEqual(b.body.input.slice(1, 4).map(i => i.type), ['reasoning', 'function_call', 'function_call']);
  const outputs = b.body.input.filter(i => i.type === 'function_call_output');
  assert.deepEqual(outputs.map(o => o.call_id), ['c1', 'c2']);
  assert.match(outputs[1].output, /E_TOOL_ARGS/u);
});

test('malformed final JSON → E_AI_MALFORMED_JSON (conversation kept for the retry feedback)', async () => {
  const { fetcher, requests } = mockFetch([reply([message('{not json')]), reply([message(JSON.stringify(patch))])]);
  const p = createOpenAIProvider({ settings, env, fetcher });
  const error = await p.propose({ system, userText: 'U', runTool: tools().run }).catch(e => e);
  assert.equal(error.code, 'E_AI_MALFORMED_JSON');
  const again = await p.propose({ system, userText: 'U', runTool: tools().run, conversation: error.conversation, feedback: 'code: E_AI_MALFORMED_JSON' });
  assert.deepEqual(again.patch, patch);
  assert.deepEqual(requests[1].body.input.at(-1), { role: 'user', content: [{ type: 'input_text', text: 'code: E_AI_MALFORMED_JSON' }] });
});

test('refusal, content filter and max_output_tokens map to stable codes', async () => {
  const cases = [
    [reply([{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }]), 'E_AI_REFUSAL'],
    [reply([], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }), 'E_AI_REFUSAL'],
    [reply([], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), 'E_AI_MAX_TOKENS'],
    [reply([message('')]), 'E_AI_NO_SUBMISSION'],
    [{ status: 'completed' }, 'E_AI_RESPONSE']
  ];
  for (const [r, codeName] of cases) {
    const { fetcher } = mockFetch([r]);
    await assert.rejects(createOpenAIProvider({ settings, env, fetcher }).propose({ system, userText: 'U', runTool: tools().run }), e => e.code === codeName);
  }
});

test('tool budget switches tool_choice to none; missing key makes no request', async () => {
  const { fetcher, requests } = mockFetch([reply([call('c1', 'find_text', { query: 'a', limit: null }), call('c2', 'find_text', { query: 'b', limit: null })]), reply([message(JSON.stringify(patch))])]);
  const t = tools();
  await createOpenAIProvider({ settings, env, fetcher }).propose({ system, userText: 'U', runTool: t.run, maxToolCalls: 1 });
  assert.equal(t.calls.length, 1);
  assert.equal(requests[1].body.tool_choice, 'none');
  assert.match(requests[1].body.input.filter(i => i.type === 'function_call_output')[1].output, /E_TOOL_BUDGET/u);
  const none = mockFetch([reply([])]);
  await assert.rejects(createOpenAIProvider({ settings, env: {}, fetcher: none.fetcher }).propose({ system, userText: 'U', runTool: tools().run }), e => e.code === 'E_AI_KEY_REQUIRED');
  assert.equal(none.requests.length, 0);
});
