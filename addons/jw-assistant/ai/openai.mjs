// OpenAI Responses API provider (raw fetch, store:false): function tools for the read-only drawing tools and a strict
// json_schema final output (Patch v2). Mirrors ai/providers.mjs request conventions; that module is left untouched.
import { patchV2JsonSchema } from '../core/patch-v2.mjs';
import { TOOL_SPECS, READ_TOOL_NAMES } from './context.mjs';
import { getApiKey, openaiBaseUrl, postJson, defaultSleep, emptyUsage, addUsage } from './settings.mjs';

const fail = (code, detail, extra = {}) => { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, detail, ...extra }); };
const BUDGET = 'Tool budget exhausted. Answer now with the final Patch v2 JSON (ops:[] and needsClarification if you could not locate the target).';
const isReasoning = model => /^(gpt-5|o\d)/u.test(String(model));
const usageOf = u => {
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  return { inputTokens: Math.max(0, (u?.input_tokens ?? 0) - cached), outputTokens: u?.output_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: 0, requests: 1 };
};

export function createOpenAIProvider({ settings, env = process.env, fetcher = fetch, sleep = defaultSleep, model } = {}) {
  const cfg = settings.providers.openai, chosen = model ?? cfg.model;

  async function call(body) {
    const key = getApiKey('openai', env);
    return postJson(`${openaiBaseUrl(env)}/v1/responses`, { headers: { Authorization: `Bearer ${key}` }, body, fetcher, timeoutMs: cfg.timeoutMs, retries: settings.loop.httpRetries, sleep, env });
  }
  function common(extra) {
    const body = { model: chosen, store: false, max_output_tokens: cfg.maxOutputTokens, ...extra };
    if (isReasoning(chosen)) { body.reasoning = { effort: cfg.reasoningEffort }; body.include = ['reasoning.encrypted_content']; }
    return body;
  }
  function checkStatus(res) {
    if (!res || !Array.isArray(res.output)) fail('E_AI_RESPONSE', 'missing output');
    if (res.status === 'incomplete') {
      const reason = res.incomplete_details?.reason;
      if (reason === 'content_filter') fail('E_AI_REFUSAL', 'content_filter');
      fail('E_AI_MAX_TOKENS', reason, { resetConversation: true });
    }
    if (res.status && !['completed', 'in_progress'].includes(res.status)) fail('E_AI_INCOMPLETE', res.status);
  }
  const messageParts = res => res.output.filter(i => i.type === 'message').flatMap(i => i.content ?? []);

  async function propose({ system, userText, runTool, maxToolCalls = settings.loop.maxToolCalls, conversation = null, feedback = null }) {
    const usage = emptyUsage();
    const input = conversation?.input && feedback ? conversation.input : [{ role: 'user', content: [{ type: 'input_text', text: userText }] }];
    if (feedback) input.push({ role: 'user', content: [{ type: 'input_text', text: feedback }] });
    const instructions = [system.static, system.knowledge].filter(s => s?.trim()).join('\n\n');
    const tools = TOOL_SPECS.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: true }));
    let toolCalls = 0, turns = 0, exhausted = false, lastModel = chosen;
    while (true) {
      if (++turns > maxToolCalls + 6) fail('E_AI_NO_SUBMISSION', 'turn limit');
      const res = await call(common({ instructions, input, tools, tool_choice: exhausted ? 'none' : 'auto', parallel_tool_calls: true,
        text: { format: { type: 'json_schema', name: 'patch_v2', strict: true, schema: patchV2JsonSchema } } }));
      addUsage(usage, usageOf(res.usage));
      checkStatus(res);
      lastModel = res.model ?? lastModel;
      input.push(...res.output);
      const calls = res.output.filter(i => i.type === 'function_call');
      if (calls.length) {
        for (const c of calls) {
          let output;
          if (!READ_TOOL_NAMES.includes(c.name)) output = JSON.stringify({ error: 'E_TOOL_UNKNOWN' });
          else if (toolCalls >= maxToolCalls) { exhausted = true; output = JSON.stringify({ error: 'E_TOOL_BUDGET', detail: BUDGET }); }
          else {
            toolCalls++;
            let args;
            try { args = JSON.parse(c.arguments ?? '{}'); } catch { args = null; }
            output = args ? runTool(c.name, args).content : JSON.stringify({ error: 'E_TOOL_ARGS', detail: 'arguments were not valid JSON' });
          }
          input.push({ type: 'function_call_output', call_id: c.call_id, output });
        }
        if (toolCalls >= maxToolCalls) { exhausted = true; input.push({ role: 'user', content: [{ type: 'input_text', text: BUDGET }] }); }
        continue;
      }
      const parts = messageParts(res);
      const refusal = parts.find(p => p.type === 'refusal');
      if (refusal) fail('E_AI_REFUSAL', String(refusal.refusal ?? '').slice(0, 200) || undefined);
      const text = parts.filter(p => p.type === 'output_text').map(p => p.text).join('');
      if (!text.trim()) fail('E_AI_NO_SUBMISSION', 'empty final message', { conversation: { input }, usage });
      let patch;
      try { patch = JSON.parse(text); }
      catch { fail('E_AI_MALFORMED_JSON', 'final message was not valid JSON', { conversation: { input }, usage }); }
      return { patch, conversation: { input }, usage, toolCalls, stopReason: res.status ?? 'completed', model: lastModel, provider: 'openai' };
    }
  }

  async function completeJson({ system, user, schema, maxTokens = 8000 }) {
    const res = await call(common({ instructions: system, input: [{ role: 'user', content: [{ type: 'input_text', text: user }] }], max_output_tokens: maxTokens,
      text: { format: { type: 'json_schema', name: 'result', strict: true, schema } } }));
    checkStatus(res);
    const parts = messageParts(res);
    if (parts.some(p => p.type === 'refusal')) fail('E_AI_REFUSAL');
    try { return { value: JSON.parse(parts.filter(p => p.type === 'output_text').map(p => p.text).join('')), usage: usageOf(res.usage), model: res.model ?? chosen }; }
    catch { fail('E_AI_MALFORMED_JSON'); }
  }

  return { name: 'openai', model: chosen, propose, completeJson };
}
