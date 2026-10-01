// AI edit loop: instruction → provider proposes Patch v2 → validate → layer check → apply → re-read & verify →
// on failure retry with the exact error → experience record per attempt. Never writes drawing files; returns bytes.
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validatePatchV2 } from '../core/patch-v2.mjs';
import { buildDrawingIndex, summarizeDrawing, renderSummary, createToolRunner, sameGeometry, shiftEntity, expandQuery, sanitizeDrawingText } from './context.mjs';
import { resolveSettings, checkDataPolicy, createRedactor, restorePatch, emptyUsage, addUsage, estimateCost, scrubSecrets } from './settings.mjs';
import { createExperienceStore, attemptRecord, classifyInstruction, detectLanguage, newRunId, sha256 } from './experience.mjs';
import { createClaudeProvider } from './claude.mjs';
import { createOpenAIProvider } from './openai.mjs';

const fail = (code, detail, extra = {}) => { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, detail, ...extra }); };
const KNOWLEDGE_DIR = new URL('../knowledge/', import.meta.url);
const PROMPT_FILE = new URL('./prompts/edit-system.md', import.meta.url);

/** Dynamic import that tolerates a module that does not exist yet (parallel development). */
export async function optionalImport(specifier) {
  try { return await import(specifier); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes(specifier.replace(/^\.\.?\//u, '').split('/').pop())) return null; throw error; }
}

export function createProvider(name, { settings, env = process.env, fetcher = fetch, sleep, model } = {}) {
  if (name === 'claude' || name === 'claude-fast') return createClaudeProvider({ settings, env, fetcher, sleep, model, fast: name === 'claude-fast' });
  if (name === 'openai') return createOpenAIProvider({ settings, env, fetcher, sleep, model });
  fail('E_AI_PROVIDER', String(name));
}

// ---- knowledge ------------------------------------------------------------------------------------------------------------
const readJson = async (url, fs) => { try { return JSON.parse(await fs.readFile(url, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; return null; } };
const PATTERN_TERMS = { layer: ['レイヤ'], dimension: ['寸法'], window: ['窓', '建具', 'サッシ'], door: ['建具', '扉', '戸'], wall: ['壁', '躯体'], grid: ['通り芯', '芯'],
  'add-text': ['文字', '室名'], 'change-text': ['文字'], room: ['室名', '室'], move: ['移動'], delete: ['削除'], 'add-line': ['線'], widen: ['開口', '寸法'] };
function queryTerms(instruction) {
  const words = String(instruction).match(/[\p{Script=Han}\p{Script=Katakana}ー]{2,}/gu) ?? [];
  return [...new Set([...expandQuery(instruction).slice(1), ...words, ...classifyInstruction(instruction).flatMap(t => PATTERN_TERMS[t] ?? [])])].filter(t => t.length >= 1);
}
const scoreText = (text, terms) => terms.reduce((n, t) => n + (String(text).includes(t) ? 1 : 0), 0);
const capJoin = (parts, max) => { let out = '', n = 0; for (const p of parts) { if (n + p.length > max) break; out += p; n += p.length; } return out; };

/** Load learned rules, relevant drafting knowledge and the office layer profile. Every source is optional. */
// ruleMode: 'active' (default, production), 'proposed' (eval of candidate rules: active + proposed), 'none' (baseline).
export async function loadKnowledge({ instruction = '', dir = KNOWLEDGE_DIR, includeProposed = false, ruleMode = includeProposed ? 'proposed' : 'active', fs = { readFile, readdir } } = {}) {
  const base = dir instanceof URL ? dir : pathToFileURL(String(dir).replace(/[\\/]?$/u, '/'));
  const tags = classifyInstruction(instruction), terms = queryTerms(instruction);
  const learned = await readJson(new URL('learned-rules.json', base), fs);
  const statuses = { none: [], active: ['active'], proposed: ['active', 'proposed'] }[ruleMode] ?? ['active'];
  const rules = (Array.isArray(learned?.rules) ? learned.rules : []).filter(r => statuses.includes(r.status))
    .filter(r => !r.trigger?.patterns?.length || r.trigger.patterns.some(p => tags.includes(p))).slice(0, 20);
  const learnedText = rules.length ? rules.map(r => `- [${r.id} v${r.version}${r.status === 'proposed' ? ' (under evaluation)' : ''}] ${r.statement_en}${r.statement_ja ? ` / ${r.statement_ja}` : ''}`).join('\n') : '(none yet)';

  const drafting = await readJson(new URL('drafting-rules.json', base), fs), catalog = await readJson(new URL('catalog.json', base), fs);
  const items = [drafting, catalog].flatMap(src => Array.isArray(src) ? src : Array.isArray(src?.rules) ? src.rules : Array.isArray(src?.items) ? src.items : Array.isArray(src?.entries) ? src.entries : []);
  const ranked = items.map(item => { const t = typeof item === 'string' ? item : JSON.stringify(item); return { t, s: scoreText(t, terms) }; })
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 12).map(x => `- ${x.t.slice(0, 600)}\n`);
  let sections = [];
  try {
    const mdDir = new URL('ja/', base);
    for (const name of (await fs.readdir(mdDir)).filter(n => n.endsWith('.md')).sort()) {
      const md = await fs.readFile(new URL(name, mdDir), 'utf8');
      for (const part of md.split(/\n(?=## )/u)) sections.push({ name, part, s: scoreText(part, terms) });
    }
  } catch {}
  sections = sections.filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.name.localeCompare(b.name)).slice(0, 3).map(x => `<!-- ${x.name} -->\n${x.part.trim().slice(0, 2500)}\n\n`);
  const draftingText = capJoin([...ranked, ...sections], 8000) || '(no matching entries)';

  const profile = await readJson(new URL('office-layer-profile.json', base), fs);
  let profileText = '(no office profile configured; follow the layer names of this drawing)';
  if (profile?.layers && typeof profile.layers === 'object') {
    profileText = Object.entries(profile.layers).sort(([a], [b]) => a.localeCompare(b)).slice(0, 64).map(([id, l]) => {
      const names = (l.names ?? []).map(n => n?.name ?? n).filter(Boolean).slice(0, 3).join('/');
      return `- ${id}: role=${l.role ?? 'unknown'}${names ? ` names=${sanitizeDrawingText(names, 60)}` : ''}${Number.isFinite(l.confidence) ? ` confidence=${l.confidence}` : ''}`;
    }).join('\n');
  }
  return { learnedRules: learnedText, draftingRules: draftingText, layerProfileSummary: profileText, profile: profile?.kind === 'jw-office-layer-profile' ? profile : null,
    stats: { learnedRules: rules.length, draftingItems: ranked.length, sections: sections.length, profile: !!profile } };
}

let promptCache = null;
export async function buildSystemPrompt(knowledge, { promptText } = {}) {
  const text = promptText ?? (promptCache ??= await readFile(PROMPT_FILE, 'utf8'));
  const [head, tail = ''] = text.split('<!-- KNOWLEDGE -->');
  const fill = tail.replace('{{LEARNED_RULES}}', knowledge.learnedRules ?? '(none yet)').replace('{{DRAFTING_RULES}}', knowledge.draftingRules ?? '(none)')
    .replace('{{LAYER_PROFILE}}', knowledge.layerProfileSummary ?? '(none)');
  return { static: head.trim(), knowledge: fill.trim() };
}
export function buildUserText(instruction, summaryText, sourceHash) {
  return `<user_instruction>\n${String(instruction).trim()}\n</user_instruction>\n\nsourceHash: ${sourceHash}\n\n${summaryText}\n\n`
    + 'Locate the targets with the read-only tools, then submit the complete Patch v2 (via the submit_patch tool when it is available, otherwise as the final JSON answer).';
}

// ---- feedback -------------------------------------------------------------------------------------------------------------
const MEANING = {
  E_PATCH_STALE: 'sourceHash does not match the drawing. Copy the sourceHash from the summary exactly.',
  E_PATCH_ENTITY: 'An id does not exist in this drawing. Use only ids returned by the tools in this conversation.',
  E_PATCH_DELETED_TARGET: 'An op references an id deleted by an earlier op in the same patch.',
  E_PATCH_LAYER: 'Unknown or malformed layer id. Use an existing "G:L" id from the summary.',
  E_PATCH_VALUE: 'A value is out of range, non-finite or malformed (points are [x, y] model mm; translate needs non-zero dx or dy).',
  E_PATCH_ZERO_LENGTH: 'A line has identical start and end points.',
  E_PATCH_EMPTY: 'The patch has no effective change. Add ops, or set needsClarification.',
  E_PATCH_SCHEMA: 'The patch does not match the Patch v2 schema (all keys required, nulls for unused fields).',
  E_PATCH_LIMIT: 'Too many ops or ids.',
  E_PATCH_TEMP_ID: 'tempId must be "n0", "n1", ... unique and not an existing id.',
  E_JWW_REWRITE_UNSAFE: 'The engine cannot safely rewrite this target (often editable=false entities or an unsupported file region). Choose editable targets or ask for clarification.',
  E_JWW_EDIT_VERIFY: 'The engine applied the patch but the re-read file did not match the expectation.',
  E_AI_LAYER_FINDINGS: 'The office layer profile rejects this patch. Use the suggested layers.',
  E_AI_VERIFY_COUNT: 'The output entity count differs from what the ops imply.',
  E_AI_VERIFY_MISMATCH: 'The re-read output does not contain the geometry this op should have produced.',
  E_AI_NO_SUBMISSION: 'No patch was submitted.',
  E_AI_MALFORMED_JSON: 'The final answer was not valid JSON.',
  E_AI_MAX_TOKENS: 'The response was cut off. Use fewer tool calls and a shorter rationale.'
};
export function idsFromDetail(detail, patch) {
  const m = /ops\[(\d+)\]/u.exec(String(detail ?? ''));
  const op = m && Array.isArray(patch?.ops) ? patch.ops[Number(m[1])] : null;
  const fromOp = op ? [...(Array.isArray(op.ids) ? op.ids : []), ...(typeof op.id === 'string' ? [op.id] : [])] : [];
  const named = [...String(detail ?? '').matchAll(/=([A-Za-z0-9_-]{1,40})/gu)].map(x => x[1]);
  return [...new Set([...fromOp, ...named])].filter(id => typeof id === 'string').slice(0, 20);
}
/** The precise retry message: code + detail path + meaning + relevant entity details (+ layer findings). */
export function buildFeedback(error, { attempt, maxAttempts, patch, tools, sourceHash, layers }) {
  const code = error.code ?? 'E_UNKNOWN', lines = [`Attempt ${attempt}/${maxAttempts} failed.`, `code: ${code}`];
  if (error.detail) lines.push(`detail: ${scrubSecrets(String(error.detail)).slice(0, 800)}`);
  lines.push(`meaning: ${MEANING[code] ?? 'See code and detail.'}`);
  if (code === 'E_PATCH_STALE') lines.push(`required sourceHash: ${sourceHash}`);
  if (code === 'E_PATCH_LAYER' && layers) lines.push(`existing non-empty layers: ${layers.join(', ')}`);
  if (Array.isArray(error.findings) && error.findings.length) {
    lines.push('layer findings:');
    for (const f of error.findings.slice(0, 12)) lines.push(`- ${f.severity} ${f.ruleId ?? ''} op=${f.opIndex ?? '?'} layer=${f.layerId ?? f.layer ?? '?'}${f.suggestedLayer ? ` suggestedLayer=${f.suggestedLayer}` : ''}: ${sanitizeDrawingText(f.ja ?? f.message ?? '', 200)}`);
  }
  const ids = idsFromDetail(error.detail, patch);
  if (tools && ids.length) {
    const known = ids.filter(id => tools.has(id));
    if (known.length) lines.push(`relevant entities (untrusted drawing data): ${tools.details(known)}`);
    const unknown = ids.filter(id => !tools.has(id));
    if (unknown.length) lines.push(`ids not in this drawing: ${unknown.map(s => sanitizeDrawingText(s, 40)).join(', ')}`);
  }
  lines.push('Fix only what the error requires and submit the complete corrected Patch v2. If the request cannot be done safely, submit ops:[] with needsClarification.');
  return lines.join('\n');
}

// ---- verification -----------------------------------------------------------------------------------------------------------
function pseudoFromSpec(entity, key) {
  const k = entity.kind, geom = { kind: k };
  if (k === 'line') Object.assign(geom, { start: entity.start, end: entity.end });
  if (k === 'text') Object.assign(geom, { at: entity.at, text: entity.text });
  if (k === 'arc') Object.assign(geom, { center: entity.center, radius: entity.radius, sweep: entity.sweepAngle });
  if (k === 'point') Object.assign(geom, { at: entity.at });
  return { id: key, kind: k, layerId: entity.layer, geom, bbox: null };
}
/**
 * Semantic re-read check on top of the engine's own verification: entity count delta and, for every op target,
 * the expected geometry/layer must exist in the re-read IR. Throws E_AI_VERIFY_COUNT / E_AI_VERIFY_MISMATCH.
 */
export function verifyAppliedPatch(before, after, normalized, { tol = 1 } = {}) {
  const adds = normalized.ops.filter(o => o.op === 'add').length, dels = normalized.ops.filter(o => o.op === 'delete').reduce((n, o) => n + o.ids.length, 0);
  const expected = before.entities.length + adds - dels;
  if (after.entities.length !== expected) fail('E_AI_VERIFY_COUNT', `expected ${expected} entities after edit, re-read has ${after.entities.length}`);
  const state = new Map(before.entities.map(e => [e.id, e])), touched = new Map();
  normalized.ops.forEach((op, i) => {
    if (op.op === 'add') { const key = op.tempId ?? `add#${i}`; state.set(key, pseudoFromSpec(op.entity, key)); touched.set(key, i); return; }
    if (op.op === 'delete') { op.ids.forEach(id => { state.delete(id); touched.delete(id); }); return; }
    const ids = op.op === 'modify' ? [op.id] : op.ids;
    for (const id of ids) {
      let e = state.get(id);
      if (!e) continue;
      if (op.op === 'translate') e = shiftEntity(e, op.dx, op.dy);
      if (op.op === 'setLayer') e = { ...e, layerId: op.layer };
      if (op.op === 'modify') {
        const g = { ...e.geom }, s = op.set;
        for (const k of ['start', 'end', 'at', 'center', 'radius', 'text']) if (k in s) g[k] = s[k];
        if ('sweepAngle' in s) g.sweep = s.sweepAngle;
        e = { ...e, geom: g };
      }
      state.set(id, e);
      if (op.op !== 'setPen') touched.set(id, i);
    }
  });
  const pool = new Map();
  for (const e of after.entities) { const k = `${e.kind}|${e.layerId}`; (pool.get(k) ?? pool.set(k, []).get(k)).push(e); }
  const used = new Set();
  for (const [key, opIndex] of touched) {
    const want = state.get(key);
    if (!want) continue;
    const candidates = pool.get(`${want.kind}|${want.layerId}`) ?? [];
    const hit = candidates.find(c => !used.has(c) && sameGeometry(want, c, tol));
    if (!hit) fail('E_AI_VERIFY_MISMATCH', `ops[${opIndex}] expected ${want.kind} on layer ${want.layerId} not found in re-read output`);
    used.add(hit);
  }
  return { checked: touched.size, entityCount: after.entities.length };
}

// ---- loop ---------------------------------------------------------------------------------------------------------------------
const FATAL = new Set(['E_AI_REFUSAL', 'E_AI_KEY_REQUIRED', 'E_AI_DATA_POLICY', 'E_AI_APPLY_UNAVAILABLE', 'E_AI_PROVIDER', 'E_AI_SETTINGS', 'E_AI_CONTEXT',
  'E_AI_HTTP_400', 'E_AI_HTTP_401', 'E_AI_HTTP_403', 'E_AI_HTTP_404', 'E_AI_HTTP_413', 'E_AI_CONTEXT_LIMIT', 'E_JWW_FORMAT']);
const isRetryable = code => !FATAL.has(code);

/**
 * Run one natural-language edit. deps (all optional, for tests/eval): env, fetch, sleep, now, loadIR(bytes),
 * applyPatchV2(bytes, patch, {ir}), checkPatchLayers(ops, ir, profile), knowledge (preloaded), knowledgeOptions,
 * experience (store | false), evalTaskId.
 */
export async function runEdit({ bytes, instruction, provider, settings, deps = {} }) {
  settings = settings?.loop?.maxAttempts && settings.experience?.resolvedDir ? settings : resolveSettings(settings ?? {}, deps.env ?? process.env);
  const env = deps.env ?? process.env, now = deps.now ?? (() => Date.now()), runId = newRunId(), started = now();
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 4000) fail('E_AI_INSTRUCTION');
  const usage = emptyUsage(), attempts = [], warnings = [];
  const finish = (status, extra = {}) => {
    const model = extra.model ?? providerObj?.model ?? null;
    return { status, runId, provider: providerObj?.name ?? (typeof provider === 'string' ? provider : null), model, attempts, usage,
      costEstimate: estimateCost(model, usage), latencyMs: now() - started, warnings, patch: null, receipt: null, outputBytes: null, ...extra };
  };
  let providerObj = null;

  const loadIR = deps.loadIR ?? (async b => {
    const [{ readJww }, { toIR }] = await Promise.all([import('../native/jww.mjs'), import('../native/jww-pipeline.mjs')]);
    return toIR(b, await readJww(b));
  });
  const ir = await loadIR(bytes);
  let policy;
  try { policy = checkDataPolicy(settings, ir.sourceHash); }
  catch (error) { return finish('failed', { error: { code: error.code, detail: error.detail } }); }
  const redactor = policy.redact ? createRedactor() : null;
  const index = buildDrawingIndex(ir, { redactor });
  const summaryText = renderSummary(summarizeDrawing(index));
  const knowledge = deps.knowledge ?? await loadKnowledge({ instruction, ...(deps.knowledgeOptions ?? {}) });
  const system = await buildSystemPrompt(knowledge, { promptText: deps.promptText });
  const userText = buildUserText(instruction, summaryText, ir.sourceHash);

  providerObj = typeof provider === 'string' || !provider
    ? createProvider(provider ?? settings.providers.default, { settings, env, fetcher: deps.fetch ?? fetch, sleep: deps.sleep, model: deps.model })
    : provider;
  const layerCheck = deps.checkPatchLayers !== undefined ? deps.checkPatchLayers : (await optionalImport('../core/layer-profile.mjs'))?.checkPatchLayers ?? null;
  const profile = deps.layerProfile !== undefined ? deps.layerProfile : knowledge.profile ?? null;
  const apply = deps.applyPatchV2 !== undefined ? deps.applyPatchV2 : (await optionalImport('../native/jww-edit.mjs'))?.applyPatchV2 ?? null;
  let store = null;
  if (deps.experience) store = deps.experience;
  else if (deps.experience !== false && settings.experience.enabled) store = createExperienceStore({ dir: settings.experience.resolvedDir, env, redact: policy.redact });

  const nonEmptyLayers = [...new Set(ir.entities.map(e => e.layerId))].sort();
  const detailRunner = createToolRunner(index);
  const toolsForFeedback = { has: id => index.byId.has(id), details: ids => detailRunner.run('entity_details', { ids }).content };
  const maxAttempts = settings.loop.maxAttempts;
  let conversation = null, feedback = null, lastPatch = null, layerWarnings = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = now(), runner = createToolRunner(index), info = { attempt, status: 'failed' };
    let patch = null, normalized = null, findings = [], applyInfo = null, validation = null, error = null, out = null;
    try {
      try { out = await providerObj.propose({ system, userText, runTool: runner.run, maxToolCalls: settings.loop.maxToolCalls, conversation, feedback, sourceHash: ir.sourceHash }); }
      catch (e) { if (e.usage) addUsage(usage, e.usage); conversation = e.conversation ?? null; throw e; }
      addUsage(usage, out.usage);
      conversation = out.conversation ?? null;
      patch = restorePatch(out.patch, redactor);
      lastPatch = patch;
      try { normalized = validatePatchV2(patch, ir); validation = { ok: true }; }
      catch (e) { validation = { ok: false, code: e.code, detail: e.detail ?? null }; throw e; }
      if (normalized.needsClarification) {
        info.status = 'clarification';
      } else {
        if (layerCheck && profile) {
          let result;
          try { result = layerCheck(normalized.ops, ir, profile); }
          catch (e) { warnings.push(`layer check unavailable: ${e.code ?? 'error'}`); result = []; }
          findings = (Array.isArray(result) ? result : result?.findings ?? []).map(f => ({ ...f }));
          const errors = findings.filter(f => f.severity === 'error');
          if (errors.length) fail('E_AI_LAYER_FINDINGS', `${errors.length} layer error(s)`, { findings: errors });
          layerWarnings = findings.filter(f => f.severity === 'warning');
        }
        if (!apply) fail('E_AI_APPLY_UNAVAILABLE', 'native/jww-edit.mjs applyPatchV2 not available');
        const applied = await apply(bytes, patch, { ir });
        let verify = { skipped: 'engine returned no ir' };
        if (applied?.ir) verify = verifyAppliedPatch(buildDrawingIndex(ir), buildDrawingIndex(applied.ir), normalized);
        applyInfo = { ok: true, outputHash: applied?.receipt?.outputHash ?? null, verify };
        info.status = 'applied';
        info.result = applied;
      }
    } catch (e) {
      error = e;
      if (!applyInfo && validation?.ok && e.code && !String(e.code).startsWith('E_AI_LAYER')) applyInfo = { ok: false, code: e.code, detail: e.detail ?? null };
      if (e.resetConversation) conversation = null;
      info.error = { code: e.code ?? 'E_UNKNOWN', detail: e.detail ? scrubSecrets(String(e.detail)).slice(0, 800) : null };
    }
    const latencyMs = now() - t0;
    const attemptUsage = out?.usage ?? error?.usage ?? emptyUsage();
    attempts.push({ attempt, status: info.status, error: info.error ?? null, toolCalls: runner.calls.length, layerFindings: findings, latencyMs, usage: attemptUsage });
    if (store) {
      try {
        await store.append(attemptRecord({ runId, attempt, instruction, sourceHash: ir.sourceHash, provider: providerObj.name, model: out?.model ?? providerObj.model,
          contextStats: { entities: index.entities.length, layers: nonEmptyLayers.length, summaryChars: summaryText.length, redacted: !!redactor, policy: policy.mode,
            knowledge: knowledge.stats ?? null }, toolCalls: runner.calls, patch, validation, layerFindings: findings, apply: applyInfo, latencyMs, usage: attemptUsage,
          error: info.error ?? null, evalTaskId: deps.evalTaskId ?? null }));
      } catch (e) { warnings.push(`experience write failed: ${e.code ?? 'error'}`); }
    }
    if (info.status === 'clarification') {
      await writeRun(store, { runId, status: 'clarification', attempts: attempt, instruction, usage, warnings });
      return finish('clarification', { patch, normalizedPatch: normalized, question: normalized.needsClarification, model: out?.model });
    }
    if (info.status === 'applied') {
      await writeRun(store, { runId, status: 'applied', attempts: attempt, instruction, usage, warnings });
      return finish('applied', { patch, normalizedPatch: normalized, receipt: info.result.receipt ?? null, outputBytes: info.result.bytes ?? null,
        outputIR: info.result.ir ?? null, layerWarnings, model: out?.model });
    }
    if (!isRetryable(info.error.code) || attempt === maxAttempts) break;
    feedback = buildFeedback(error, { attempt, maxAttempts, patch, tools: toolsForFeedback, sourceHash: ir.sourceHash, layers: nonEmptyLayers });
  }
  const last = attempts.at(-1)?.error ?? null;
  await writeRun(store, { runId, status: 'failed', attempts: attempts.length, instruction, usage, warnings, error: last });
  return finish('failed', { patch: lastPatch, error: last });

  async function writeRun(s, record) {
    if (!s) return;
    try {
      await s.append({ type: 'run', ...record, instruction: undefined, instructionHash: sha256(record.instruction), language: detectLanguage(record.instruction),
        patterns: classifyInstruction(record.instruction), sourceHash: ir.sourceHash, provider: providerObj.name, model: providerObj.model,
        evalTaskId: deps.evalTaskId ?? null, costEstimate: estimateCost(providerObj.model, record.usage), latencyMs: now() - started });
    } catch (e) { warnings.push(`experience write failed: ${e.code ?? 'error'}`); }
  }
}
