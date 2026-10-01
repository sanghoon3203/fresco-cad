// Self-systematizing rules: experience → deterministic summary → model-distilled, drawing-agnostic rule proposals →
// eval-gated promotion. learned-rules.json lives in the repo, so every rule passes a sanitizer that rejects
// drawing contents (ids, coordinates, hashes, paths, project texts) before it can be stored.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { TERM_GLOSSARY, normalizeText } from './context.mjs';
import { INSTRUCTION_PATTERNS } from './experience.mjs';

const fail = (code, detail) => { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, detail }); };
export const LEARNED_RULES_FILE = new URL('../knowledge/learned-rules.json', import.meta.url);
export const RULES_SCHEMA = 1;
const PATTERN_TAGS = Object.keys(INSTRUCTION_PATTERNS);
const inc = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };
const sortedCounts = o => Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, count]) => ({ key, count }));
const rate = (n, d) => d ? Math.round(n / d * 1000) / 1000 : null;

/** Deterministic statistics over experience records (attempt / run / feedback). */
export function summarizeExperience(records) {
  const attempts = records.filter(r => r?.type === 'attempt'), runs = records.filter(r => r?.type === 'run'), feedback = records.filter(r => r?.type === 'feedback');
  const failureCodes = {}, byPattern = {}, byLanguage = {}, fixes = {}, tools = {}, models = {}, statuses = {}, verdicts = {};
  for (const a of attempts) {
    if (a.error?.code) inc(failureCodes, a.error.code);
    for (const t of a.toolCalls ?? []) inc(tools, t.name);
    inc(models, `${a.provider ?? '?'}/${a.model ?? '?'}`);
  }
  for (const r of runs) {
    inc(statuses, r.status);
    inc(byLanguage, r.language ?? '?');
    for (const p of r.patterns?.length ? r.patterns : ['(none)']) {
      byPattern[p] ??= { runs: 0, applied: 0, clarification: 0, failed: 0, attempts: 0 };
      byPattern[p].runs++; byPattern[p][r.status] = (byPattern[p][r.status] ?? 0) + 1; byPattern[p].attempts += r.attempts ?? 0;
    }
  }
  const byRun = new Map();
  for (const a of attempts) (byRun.get(a.runId) ?? byRun.set(a.runId, []).get(a.runId)).push(a);
  for (const list of byRun.values()) {
    list.sort((a, b) => a.attempt - b.attempt);
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i], b = list[i + 1];
      if (!a.error?.code) continue;
      const outcome = b.error?.code ? `still-failing:${b.error.code}` : b.validation?.ok ? 'fixed' : 'other';
      const key = `${a.error.code} -> ${outcome} | ops ${(a.opKinds ?? []).join('+') || '-'} => ${(b.opKinds ?? []).join('+') || '-'}`;
      inc(fixes, key);
    }
  }
  for (const f of feedback) inc(verdicts, f.verdict);
  const firstOk = [...byRun.values()].filter(l => l.length && !l[0].error).length;
  return {
    totals: { runs: runs.length, attempts: attempts.length, feedback: feedback.length, attemptsPerRun: rate(attempts.length, runs.length || byRun.size), firstAttemptSuccessRate: rate(firstOk, byRun.size) },
    statuses: sortedCounts(statuses), failureCodes: sortedCounts(failureCodes),
    byPattern: Object.fromEntries(Object.entries(byPattern).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { ...v, successRate: rate(v.applied + v.clarification, v.runs) }])),
    byLanguage: sortedCounts(byLanguage), fixes: sortedCounts(fixes).slice(0, 40), toolUsage: sortedCounts(tools), models: sortedCounts(models), feedback: sortedCounts(verdicts)
  };
}

// ---- sanitizer --------------------------------------------------------------------------------------------------------------
const GENERIC = new Set([...TERM_GLOSSARY.flatMap(([, ja]) => ja), '洋室', '和室', '寝室', 'LDK', 'DK', 'WC', 'PS', 'EV', 'UP', 'DN', 'リビング', 'キッチン', 'トイレ', '浴室',
  '玄関', '廊下', '階段', '押入', '収納', 'ホール', 'ベランダ', 'バルコニー', '洗面所', '脱衣', 'クローゼット', '下駄箱', '建具', '寸法', '室名', '通り芯', '躯体', '仕上'].map(normalizeText));
const UNSAFE = [
  ['entity-id', /(^|[^A-Za-z0-9])[eE]\d{1,7}(?![A-Za-z0-9])/u], ['hash', /[0-9a-f]{16,}/iu], ['windows-path', /[A-Za-z]:[\\/]/u], ['unc-path', /\\\\/u],
  ['home-path', /\/(Users|home)\//iu], ['file-name', /\.(jww|jwc|jws|jwk|dxf|dwg|pdf|xlsx?)(?![A-Za-z])/iu], ['coordinate', /[[(]\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*[\])]/u],
  ['long-number', /\d{6,}/u], ['precise-decimal', /\d+\.\d{3,}/u], ['url', /https?:\/\//iu], ['email', /[^\s@]+@[^\s@]+\.[^\s@]+/u], ['placeholder', /«T\d+»/u],
  ['control', /[\u0000-\u0008\u000b-\u001f]/u]
];
/** Return the reasons a rule statement is unsafe to store in the repository (empty array = safe). */
export function ruleTextProblems(text, { forbidden = [] } = {}) {
  const s = String(text ?? ''), reasons = UNSAFE.filter(([, re]) => re.test(s)).map(([name]) => name);
  if (!s.trim()) reasons.push('empty');
  if (s.length > 400) reasons.push('too-long');
  const n = normalizeText(s);
  for (const f of forbidden) {
    const fn = normalizeText(f);
    if (fn.length >= 3 && !GENERIC.has(fn) && n.includes(fn)) { reasons.push('drawing-text'); break; }
  }
  return reasons;
}
/** Strings that must never appear in learned rules: texts the model wrote into real drawings, plus caller extras. */
export function forbiddenStringsFrom(records, extra = []) {
  const out = new Set(extra.map(String));
  for (const r of records) for (const op of r?.patch?.ops ?? []) {
    if (typeof op?.entity?.text === 'string') out.add(op.entity.text);
    if (typeof op?.set?.text === 'string') out.add(op.set.text);
  }
  return [...out];
}
const RULE_KEYS = ['id', 'version', 'statement_en', 'statement_ja', 'trigger', 'evidenceCount', 'successRateBefore', 'successRateAfter', 'status'];
export function validateRule(rule, opts = {}) {
  if (!rule || typeof rule !== 'object') fail('E_RULE_SCHEMA');
  for (const k of RULE_KEYS) if (!(k in rule)) fail('E_RULE_SCHEMA', k);
  if (!/^lr-[0-9a-f]{8}$/u.test(rule.id) || !Number.isInteger(rule.version) || rule.version < 1) fail('E_RULE_SCHEMA', 'id/version');
  if (!['proposed', 'active', 'retired'].includes(rule.status)) fail('E_RULE_SCHEMA', 'status');
  if (!Array.isArray(rule.trigger?.patterns) || !Array.isArray(rule.trigger?.errorCodes) || rule.trigger.patterns.some(p => !PATTERN_TAGS.includes(p))
    || rule.trigger.errorCodes.some(c => !/^E_[A-Z0-9_]{2,40}$/u.test(c))) fail('E_RULE_SCHEMA', 'trigger');
  for (const k of ['successRateBefore', 'successRateAfter']) if (rule[k] !== null && !(Number.isFinite(rule[k]) && rule[k] >= 0 && rule[k] <= 1)) fail('E_RULE_SCHEMA', k);
  for (const k of ['statement_en', 'statement_ja']) {
    const problems = ruleTextProblems(rule[k], opts);
    if (problems.length) fail('E_RULE_UNSAFE', `${rule.id}.${k}: ${problems.join(',')}`);
  }
  for (const [k, v] of Object.entries(rule)) if (typeof v === 'string' && !['id', 'statement_en', 'statement_ja'].includes(k)) {
    const problems = ruleTextProblems(v, opts).filter(p => p !== 'empty');
    if (problems.length) fail('E_RULE_UNSAFE', `${rule.id}.${k}: ${problems.join(',')}`);
  }
  return rule;
}
export function validateRulesDoc(doc, opts = {}) {
  if (!doc || doc.schemaVersion !== RULES_SCHEMA || !Number.isInteger(doc.version) || !Array.isArray(doc.rules)) fail('E_RULE_SCHEMA', 'document');
  const ids = new Set();
  for (const rule of doc.rules) { validateRule(rule, opts); if (ids.has(rule.id)) fail('E_RULE_SCHEMA', `duplicate ${rule.id}`); ids.add(rule.id); }
  return doc;
}
export const ruleId = statement => `lr-${createHash('sha256').update(normalizeText(statement)).digest('hex').slice(0, 8)}`;

// ---- distillation -----------------------------------------------------------------------------------------------------------
export const DISTILL_SCHEMA = { type: 'object', additionalProperties: false, required: ['rules'], properties: { rules: { type: 'array', items: {
  type: 'object', additionalProperties: false, required: ['statement_en', 'statement_ja', 'patterns', 'errorCodes', 'rationale'],
  properties: { statement_en: { type: 'string' }, statement_ja: { type: 'string' }, patterns: { type: 'array', items: { type: 'string', enum: PATTERN_TAGS } },
    errorCodes: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' } } } } } };
const DISTILL_SYSTEM = `You maintain the learned drafting rules of a Jw_cad editing assistant used by a Japanese architecture office.
From aggregate statistics of past edit attempts, propose a few GENERAL rules that would prevent the observed failures or speed up success.
Rules must be drawing-agnostic and client-agnostic: never include coordinates, entity ids, hashes, file names, project or client names, or text copied from drawings.
Good: "When widening a window in plan, move both jamb lines and the dimension text; keep the opening on the 建具 layer."
Good: "Before deleting a room label, confirm with find_text that exactly one text matches; otherwise ask which one."
Each rule: an English statement, a Japanese statement (建築実務の用語で), trigger patterns (instruction tags) and error codes it addresses.
Propose at most 8 rules; prefer fewer, high-evidence rules. Do not restate existing rules.`;

/** Ask a provider (anything with completeJson) to propose generalized rules; returns a merged, sanitized document. */
export async function distillRules({ records, currentRules, provider, forbidden = [], now = () => new Date() }) {
  if (!provider?.completeJson) fail('E_RULE_PROVIDER');
  const doc = currentRules ?? { schemaVersion: RULES_SCHEMA, version: 0, rules: [] };
  validateRulesDoc(doc);
  const summary = summarizeExperience(records), banned = forbiddenStringsFrom(records, forbidden);
  const user = JSON.stringify({ summary, patternTags: PATTERN_TAGS, existingRules: doc.rules.filter(r => r.status !== 'retired').map(r => ({ id: r.id, statement_en: r.statement_en, status: r.status })) });
  const { value, usage, model } = await provider.completeJson({ system: DISTILL_SYSTEM, user, schema: DISTILL_SCHEMA });
  const proposals = Array.isArray(value?.rules) ? value.rules.slice(0, 8) : [];
  const rejected = [], accepted = [], next = structuredClone(doc);
  for (const p of proposals) {
    const patterns = Array.isArray(p?.patterns) ? [...new Set(p.patterns.filter(t => PATTERN_TAGS.includes(t)))].sort() : [];
    const errorCodes = Array.isArray(p?.errorCodes) ? [...new Set(p.errorCodes.filter(c => /^E_[A-Z0-9_]{2,40}$/u.test(c)))].sort() : [];
    const problems = [...ruleTextProblems(p?.statement_en, { forbidden: banned }), ...ruleTextProblems(p?.statement_ja, { forbidden: banned })];
    if (problems.length) { rejected.push({ reasons: [...new Set(problems)] }); continue; } // never echo the unsafe text
    const id = ruleId(p.statement_en);
    const evidenceCount = records.filter(r => r?.type === 'attempt' && ((r.error?.code && errorCodes.includes(r.error.code)) || (r.patterns ?? []).some(t => patterns.includes(t)))).length;
    const existing = next.rules.find(r => r.id === id);
    if (existing) { existing.evidenceCount = Math.max(existing.evidenceCount, evidenceCount); continue; }
    const rule = { id, version: 1, statement_en: p.statement_en.trim(), statement_ja: p.statement_ja.trim(), trigger: { patterns, errorCodes }, evidenceCount,
      successRateBefore: null, successRateAfter: null, status: 'proposed', proposedAt: now().toISOString().slice(0, 10) };
    validateRule(rule, { forbidden: banned });
    next.rules.push(rule); accepted.push(id);
  }
  if (accepted.length) { next.version = doc.version + 1; next.updatedAt = now().toISOString().slice(0, 10); }
  return { doc: next, accepted, rejected, usage, model, summary };
}

// ---- eval-gated promotion -----------------------------------------------------------------------------------------------------
const triggered = (rule, task) => !rule.trigger.patterns.length || (task.patterns ?? []).some(p => rule.trigger.patterns.includes(p));
const passRate = tasks => tasks.length ? tasks.filter(t => t.passed).length / tasks.length : null;
/**
 * Promote proposed rules to active only when the eval run WITH the rules (evalAfter) beats the run without them
 * (evalBefore) on the tasks the rule triggers, without lowering the overall pass rate. Measured rates are recorded
 * either way; rules that do not improve stay 'proposed'.
 */
export function promoteRules({ rulesDoc, evalBefore, evalAfter, minDelta = 0, now = () => new Date() }) {
  validateRulesDoc(rulesDoc);
  const before = new Map((evalBefore?.tasks ?? []).map(t => [t.id, t])), after = (evalAfter?.tasks ?? []).filter(t => before.has(t.id) && t.status !== 'skipped' && before.get(t.id).status !== 'skipped');
  const included = new Set(evalAfter?.rules?.included ?? []);
  const overallBefore = passRate(after.map(t => before.get(t.id))), overallAfter = passRate(after);
  const doc = structuredClone(rulesDoc), promoted = [], kept = [];
  for (const rule of doc.rules) {
    if (rule.status !== 'proposed' || (included.size && !included.has(rule.id))) continue;
    const tasks = after.filter(t => triggered(rule, t));
    const b = passRate(tasks.map(t => before.get(t.id))), a = passRate(tasks);
    rule.successRateBefore = b === null ? null : Math.round(b * 1000) / 1000;
    rule.successRateAfter = a === null ? null : Math.round(a * 1000) / 1000;
    if (tasks.length && a - b > minDelta && overallAfter >= overallBefore) {
      rule.status = 'active'; rule.version += 1; rule.promotedAt = now().toISOString().slice(0, 10); promoted.push(rule.id);
    } else kept.push(rule.id);
  }
  if (promoted.length || kept.length) { doc.version += 1; doc.updatedAt = now().toISOString().slice(0, 10); }
  return { doc, promoted, kept, overall: { before: overallBefore, after: overallAfter, tasks: after.length } };
}
export function retireRules(rulesDoc, ids) {
  const doc = structuredClone(rulesDoc);
  for (const r of doc.rules) if (ids.includes(r.id) && r.status !== 'retired') { r.status = 'retired'; r.version += 1; }
  doc.version += 1;
  return validateRulesDoc(doc);
}

export async function loadLearnedRules(file = LEARNED_RULES_FILE) {
  try { return validateRulesDoc(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { schemaVersion: RULES_SCHEMA, version: 0, rules: [] }; throw error; }
}
/** Validate (schema + sanitizer) and write atomically. Refuses any document containing drawing data. */
export async function saveLearnedRules(doc, file = LEARNED_RULES_FILE, opts = {}) {
  validateRulesDoc(doc, opts);
  const target = file instanceof URL ? fileURLToPath(file) : file, tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  await rename(tmp, target);
  return doc;
}
