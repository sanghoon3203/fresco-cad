// Anthropic Messages API provider (raw fetch, zero dependencies): agentic tool-use loop over read-only drawing tools
// with a final `submit_patch` tool whose input_schema is Patch v2. Append-only history (thinking blocks are replayed
// unchanged), prompt caching on the static system prompt + knowledge block, refusal/max_tokens/timeout handling.
import { patchV2JsonSchema } from '../core/patch-v2.mjs';
import { TOOL_SPECS, READ_TOOL_NAMES } from './context.mjs';
import { getApiKey, anthropicBaseUrl, postJson, defaultSleep, emptyUsage, addUsage } from './settings.mjs';

const fail = (code, detail, extra = {}) => { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, detail, ...extra }); };
const CACHE = { type: 'ephemeral' };
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const NUDGE = 'You have not submitted. Call the submit_patch tool now with the complete Patch v2 (ops:[] and needsClarification if the request is ambiguous).';
const BUDGET = 'Tool budget exhausted: do not call read-only tools again. Call submit_patch now (ops:[] and needsClarification if you could not locate the target).';

/** Model capability traits that change the request shape. */
export function claudeTraits(model) {
  const m = String(model);
  const is = list => list.some(p => m === p || m.startsWith(`${p}-`));
  return {
    adaptiveThinking: !is(['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5', 'claude-opus-4-1']) && !m.startsWith('claude-3'),
    // Opus 5.5 / Sonnet 5.5 / Fable 5.1 reject forced tool_choice (any/tool) with a 400.
    forcedToolChoice: !is(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-mythos-5-1']),
    serverFallback: is(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-fable-5'])
  };
}
// Strict tool schemas do not support array-length / numeric / string-length constraints: strip them (validatePatchV2 enforces them).
export function toStrictToolSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toStrictToolSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const drop = new Set(['minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern']);
  return Object.fromEntries(Object.entries(schema).filter(([k]) => !drop.has(k)).map(([k, v]) => [k, toStrictToolSchema(v)]));
}
const usageOf = u => ({ inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0, cacheReadTokens: u?.cache_read_input_tokens ?? 0,
  cacheWriteTokens: u?.cache_creation_input_tokens ?? 0, requests: 1 });

export function createClaudeProvider({ settings, env = process.env, fetcher = fetch, sleep = defaultSleep, model, fast = false } = {}) {
  const cfg = settings.providers.claude, chosen = model ?? (fast ? cfg.fastModel : cfg.model), traits = claudeTraits(chosen);
  let strict = cfg.strictSubmit !== false;

  async function call(body, betas = []) {
    const key = getApiKey('claude', env);
    const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...(betas.length ? { 'anthropic-beta': betas.join(',') } : {}) };
    return postJson(`${anthropicBaseUrl(env)}/v1/messages`, { headers, body, fetcher, timeoutMs: cfg.timeoutMs, retries: settings.loop.httpRetries, sleep, env });
  }
  function common(extra = {}) {
    const body = { model: chosen, max_tokens: cfg.maxTokens, ...extra };
    if (traits.adaptiveThinking) { body.thinking = { type: 'adaptive' }; body.output_config = { ...(body.output_config ?? {}), effort: cfg.effort }; }
    const betas = [];
    if (cfg.refusalFallback && traits.serverFallback) { body.fallbacks = 'default'; betas.push(FALLBACK_BETA); }
    return { body, betas };
  }
  function checkStop(res) {
    if (!res || !Array.isArray(res.content)) fail('E_AI_RESPONSE', 'missing content');
    if (res.stop_reason === 'refusal') fail('E_AI_REFUSAL', res.stop_details?.category ?? undefined);
    if (res.stop_reason === 'max_tokens') fail('E_AI_MAX_TOKENS', undefined, { resetConversation: true });
    if (res.stop_reason === 'model_context_window_exceeded') fail('E_AI_CONTEXT_LIMIT', undefined, { resetConversation: true });
  }

  /**
   * Run the tool loop until the model calls submit_patch.
   * conversation: opaque state from a previous attempt (append-only). feedback: retry message (sent as the
   * submit_patch tool_result when one is pending, else as a user turn).
   */
  async function propose({ system, userText, runTool, maxToolCalls = settings.loop.maxToolCalls, conversation = null, feedback = null }) {
    const usage = emptyUsage();
    let messages;
    if (conversation?.messages && feedback) {
      messages = conversation.messages;
      messages.push(conversation.submitId
        ? { role: 'user', content: [...conversation.pending, { type: 'tool_result', tool_use_id: conversation.submitId, is_error: true, content: feedback }] }
        : { role: 'user', content: [{ type: 'text', text: feedback }] });
    } else {
      messages = [{ role: 'user', content: [{ type: 'text', text: userText }, ...(feedback ? [{ type: 'text', text: feedback }] : [])] }];
    }
    const systemBlocks = [{ type: 'text', text: system.static, cache_control: CACHE }, ...(system.knowledge?.trim() ? [{ type: 'text', text: system.knowledge, cache_control: CACHE }] : [])];
    const submitTool = () => ({ name: 'submit_patch', description: 'Submit the final Patch v2 for this attempt. Call exactly once, after locating targets with the read-only tools.',
      input_schema: strict ? toStrictToolSchema(patchV2JsonSchema) : patchV2JsonSchema, ...(strict ? { strict: true } : {}) });
    const readTools = TOOL_SPECS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    let toolCalls = 0, turns = 0, nudged = false, exhausted = false, lastModel = chosen, stopReason = null;
    while (true) {
      if (++turns > maxToolCalls + 6) fail('E_AI_NO_SUBMISSION', 'turn limit');
      // Forced tool_choice only where the model accepts it and thinking is off; otherwise the BUDGET text steers it.
      const force = exhausted && traits.forcedToolChoice && !traits.adaptiveThinking;
      const { body, betas } = common({ system: systemBlocks, messages, tools: [...readTools, submitTool()],
        tool_choice: force ? { type: 'tool', name: 'submit_patch' } : { type: 'auto' }, cache_control: CACHE });
      let res;
      try { res = await call(body, betas); }
      catch (error) {
        // A strict-schema rejection must not take the whole loop down: retry once with plain JSON schema.
        if (strict && error.code === 'E_AI_HTTP_400' && /strict|schema|grammar/iu.test(error.detail ?? '')) { strict = false; turns--; continue; }
        throw error;
      }
      addUsage(usage, usageOf(res.usage));
      checkStop(res);
      lastModel = res.model ?? lastModel; stopReason = res.stop_reason;
      messages.push({ role: 'assistant', content: res.content });
      if (res.stop_reason === 'pause_turn') continue;
      const uses = res.content.filter(b => b.type === 'tool_use');
      const submit = uses.find(u => u.name === 'submit_patch');
      if (submit) {
        const pending = uses.filter(u => u !== submit).map(u => ({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Not executed: submit_patch was called in the same turn.' }));
        return { patch: submit.input, conversation: { messages, pending, submitId: submit.id }, usage, toolCalls, stopReason, model: lastModel, provider: 'claude' };
      }
      if (!uses.length) {
        if (nudged) fail('E_AI_NO_SUBMISSION', 'model ended without submit_patch', { conversation: { messages, pending: [], submitId: null }, usage });
        nudged = true;
        messages.push({ role: 'user', content: [{ type: 'text', text: NUDGE }] });
        continue;
      }
      const results = uses.map(u => {
        if (!READ_TOOL_NAMES.includes(u.name)) return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: `Unknown tool ${String(u.name).slice(0, 40)}.` };
        if (toolCalls >= maxToolCalls) { exhausted = true; return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: BUDGET }; }
        toolCalls++;
        const out = runTool(u.name, u.input);
        return { type: 'tool_result', tool_use_id: u.id, content: out.content, ...(out.ok ? {} : { is_error: true }) };
      });
      if (toolCalls >= maxToolCalls) { exhausted = true; results.push({ type: 'text', text: BUDGET }); }
      messages.push({ role: 'user', content: results });
    }
  }

  /** One structured-JSON completion (used by rule distillation). */
  async function completeJson({ system, user, schema, maxTokens = 8000 }) {
    const { body, betas } = common({ max_tokens: maxTokens, system: [{ type: 'text', text: system, cache_control: CACHE }],
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }] });
    body.output_config = { ...(body.output_config ?? {}), format: { type: 'json_schema', schema: toStrictToolSchema(schema) } };
    const res = await call(body, betas);
    checkStop(res);
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
    try { return { value: JSON.parse(text), usage: usageOf(res.usage), model: res.model ?? chosen }; }
    catch { fail('E_AI_MALFORMED_JSON'); }
  }

  return { name: fast ? 'claude-fast' : 'claude', model: chosen, propose, completeJson };
}
