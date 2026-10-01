// Evaluation harness: run eval/tasks/*.json through runEdit for one provider/model, score machine checks, write a
// JSON + Markdown report, and record experience. `--dry` uses the mock provider + in-memory simulator (no keys, no cost).
//
//   node eval/run-eval.mjs --dry
//   node eval/run-eval.mjs --provider claude --model claude-opus-5-5 --lang both --rules active --out C:/tmp/eval-a
//   node eval/run-eval.mjs --provider openai --filter apt- --max-attempts 2
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runEdit, createProvider } from '../ai/edit-loop.mjs';
import { buildDrawingIndex } from '../ai/context.mjs';
import { resolveSettings, loadSettings, emptyUsage, addUsage, estimateCost } from '../ai/settings.mjs';
import { createExperienceStore, classifyInstruction, sha256 } from '../ai/experience.mjs';
import { loadLearnedRules } from '../ai/rule-learning.mjs';
import { validateTask, scoreTask } from './checks.mjs';
import { createMockProvider, createSimulatedApply } from './mock.mjs';

export const TASK_DIR = fileURLToPath(new URL('./tasks/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export async function loadTasks(dir = TASK_DIR) {
  const tasks = [];
  for (const name of (await readdir(dir)).filter(n => n.endsWith('.json')).sort()) {
    const data = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    for (const t of Array.isArray(data) ? data : [data]) tasks.push(validateTask({ ...t, sourceFile: name }));
  }
  const ids = new Set();
  for (const t of tasks) { if (ids.has(t.id)) throw Object.assign(new Error(`E_EVAL_TASK: duplicate ${t.id}`), { code: 'E_EVAL_TASK' }); ids.add(t.id); }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}
/** Tasks name corpus files as C:/JWW/<name>; FRESCO_JWW_CORPUS relocates that folder. */
export function resolveCorpusPath(file, env = process.env) {
  const corpus = env.FRESCO_JWW_CORPUS;
  return corpus ? file.replace(/^C:[\\/]JWW[\\/]/iu, `${corpus.replace(/[\\/]+$/u, '')}/`) : file;
}
export function taskCases(task, lang = 'both') {
  const langs = lang === 'both' ? ['ja', 'ko'] : [lang];
  return langs.filter(l => task[`instruction_${l}`]).map(l => ({ caseId: `${task.id}#${l}`, lang: l, instruction: task[`instruction_${l}`] }));
}

/**
 * Run tasks and return a report. deps: readBytes(path), loadIR(bytes), applyPatchV2, checkPatchLayers, experience
 * (store | false), env, fetch, sleep. provider: name or provider object.
 */
export async function runEval({ tasks, provider = 'claude', model, settings, lang = 'both', dry = false, rules = 'active', deps = {}, onProgress = () => {} }) {
  const env = deps.env ?? process.env;
  settings = settings?.experience?.resolvedDir ? settings : resolveSettings(settings ?? {}, env);
  const irCache = new Map(), baseLoad = deps.loadIR ?? (async b => {
    const [{ readJww }, { toIR }] = await Promise.all([import('../native/jww.mjs'), import('../native/jww-pipeline.mjs')]);
    return toIR(b, await readJww(b));
  });
  const loadIR = async bytes => { const h = sha256(bytes); if (!irCache.has(h)) irCache.set(h, await baseLoad(bytes)); return irCache.get(h); };
  const providerObj = typeof provider === 'object' ? provider : dry ? createMockProvider() : createProvider(provider, { settings, env, fetcher: deps.fetch ?? fetch, sleep: deps.sleep, model });
  const apply = deps.applyPatchV2 !== undefined ? deps.applyPatchV2 : dry ? createSimulatedApply(loadIR) : undefined;
  let store = false;
  if (deps.experience) store = deps.experience;
  else if (deps.experience !== false && !dry && settings.experience.enabled) store = createExperienceStore({ dir: settings.experience.resolvedDir, env, redact: settings.dataPolicy.redactText });
  const rulesDoc = deps.rulesDoc ?? await loadLearnedRules().catch(() => ({ rules: [] }));
  const included = rules === 'none' ? [] : rulesDoc.rules.filter(r => r.status === 'active' || (rules === 'proposed' && r.status === 'proposed')).map(r => r.id);
  const readBytes = deps.readBytes ?? (p => readFile(p));
  const started = new Date().toISOString(), cases = [], usage = emptyUsage();

  for (const task of tasks) {
    for (const c of taskCases(task, lang)) {
      const base = { id: c.caseId, taskId: task.id, category: task.category ?? 'other', lang: c.lang, patterns: classifyInstruction(c.instruction), file: path.basename(task.file) };
      let bytes;
      try { bytes = await readBytes(resolveCorpusPath(task.file, env)); }
      catch (error) { cases.push({ ...base, status: 'skipped', passed: false, score: 0, reason: error.code ?? 'unreadable' }); onProgress(cases.at(-1)); continue; }
      try {
        const irBefore = await loadIR(bytes);
        const result = await runEdit({ bytes, instruction: c.instruction, provider: providerObj, settings, deps: { env, loadIR, ...(apply !== undefined ? { applyPatchV2: apply } : {}),
          ...(deps.checkPatchLayers !== undefined ? { checkPatchLayers: deps.checkPatchLayers } : {}), ...(deps.layerProfile !== undefined ? { layerProfile: deps.layerProfile } : {}),
          ...(deps.knowledge ? { knowledge: deps.knowledge } : {}), knowledgeOptions: { ruleMode: rules }, experience: store, evalTaskId: c.caseId, now: deps.now } });
        addUsage(usage, result.usage);
        const before = buildDrawingIndex(irBefore), after = result.outputIR ? buildDrawingIndex(result.outputIR) : null;
        const score = scoreTask(task, { before, after, result });
        cases.push({ ...base, status: result.status, passed: score.passed, score: score.score, checks: score.checks, attempts: result.attempts.length,
          errorCode: result.error?.code ?? null, question: result.question ?? null, usage: result.usage, costEstimate: result.costEstimate, latencyMs: result.latencyMs, runId: result.runId });
      } catch (error) {
        cases.push({ ...base, status: 'error', passed: false, score: 0, errorCode: error.code ?? 'E_EVAL_RUN', reason: String(error.detail ?? error.message ?? '').slice(0, 300) });
      }
      onProgress(cases.at(-1));
    }
  }
  return { schemaVersion: 1, startedAt: started, finishedAt: new Date().toISOString(), provider: providerObj.name, model: providerObj.model, dry, lang,
    rules: { mode: rules, included }, tasks: cases, summary: summarize(cases, usage, providerObj.model) };
}

function summarize(cases, usage, model) {
  const ran = cases.filter(c => c.status !== 'skipped'), group = key => {
    const out = {};
    for (const c of ran) { const g = out[c[key]] ??= { cases: 0, passed: 0 }; g.cases++; if (c.passed) g.passed++; }
    for (const g of Object.values(out)) g.passRate = Math.round(g.passed / g.cases * 1000) / 1000;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  const statuses = {}; for (const c of cases) statuses[c.status] = (statuses[c.status] ?? 0) + 1;
  const passed = ran.filter(c => c.passed).length;
  return { cases: cases.length, executed: ran.length, skipped: cases.length - ran.length, passed, passRate: ran.length ? Math.round(passed / ran.length * 1000) / 1000 : null,
    meanScore: ran.length ? Math.round(ran.reduce((n, c) => n + c.score, 0) / ran.length * 1000) / 1000 : null,
    attemptsAvg: ran.length ? Math.round(ran.reduce((n, c) => n + (c.attempts ?? 0), 0) / ran.length * 100) / 100 : null,
    byCategory: group('category'), byLanguage: group('lang'), statuses, usage, costEstimate: estimateCost(model, usage) };
}

export function renderMarkdown(report) {
  const s = report.summary, pct = v => v === null || v === undefined ? '-' : `${Math.round(v * 1000) / 10}%`;
  const lines = [`# AI edit eval — ${report.provider} / ${report.model}${report.dry ? ' (dry)' : ''}`, '',
    `- started: ${report.startedAt}`, `- rules: ${report.rules.mode} (${report.rules.included.length} included)`,
    `- cases: ${s.cases} (executed ${s.executed}, skipped ${s.skipped}) — passed ${s.passed} (${pct(s.passRate)}), mean score ${s.meanScore ?? '-'}, avg attempts ${s.attemptsAvg ?? '-'}`,
    `- tokens: in ${s.usage.inputTokens}, out ${s.usage.outputTokens}, cache read ${s.usage.cacheReadTokens}, cache write ${s.usage.cacheWriteTokens} — approx cost ${s.costEstimate.usd === null ? 'n/a' : `$${s.costEstimate.usd.toFixed(4)}`} (approximate)`,
    '', '| category | cases | passed | rate |', '|---|---|---|---|',
    ...Object.entries(s.byCategory).map(([k, v]) => `| ${k} | ${v.cases} | ${v.passed} | ${pct(v.passRate)} |`),
    '', '| language | cases | passed | rate |', '|---|---|---|---|',
    ...Object.entries(s.byLanguage).map(([k, v]) => `| ${k} | ${v.cases} | ${v.passed} | ${pct(v.passRate)} |`),
    '', '| case | status | pass | score | attempts | failed checks / error |', '|---|---|---|---|---|---|',
    ...report.tasks.map(c => `| ${c.id} | ${c.status} | ${c.passed ? 'yes' : 'no'} | ${c.score ?? 0} | ${c.attempts ?? '-'} | ${[c.errorCode, ...(c.checks ?? []).filter(x => !x.passed).map(x => `${x.type}: ${x.detail}`), c.reason].filter(Boolean).join('; ').replace(/\|/gu, '/').slice(0, 220)} |`)];
  return lines.join('\n') + '\n';
}
export async function writeReport(report, outDir) {
  await mkdir(outDir, { recursive: true });
  const json = path.join(outDir, 'report.json'), md = path.join(outDir, 'report.md');
  await writeFile(json, JSON.stringify(report, null, 2) + '\n', 'utf8');
  await writeFile(md, renderMarkdown(report), 'utf8');
  return { json, md };
}

export function parseArgs(argv) {
  const args = { provider: null, model: null, lang: 'both', tasks: TASK_DIR, out: null, dry: false, filter: null, rules: 'active', experience: true, maxAttempts: null, experienceDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`); return argv[++i]; };
    if (a === '--dry') args.dry = true;
    else if (a === '--no-experience') args.experience = false;
    else if (a === '--provider') args.provider = v();
    else if (a === '--model') args.model = v();
    else if (a === '--lang') args.lang = v();
    else if (a === '--tasks') args.tasks = v();
    else if (a === '--out') args.out = v();
    else if (a === '--filter') args.filter = v();
    else if (a === '--rules') args.rules = v();
    else if (a === '--max-attempts') args.maxAttempts = Number(v());
    else if (a === '--experience-dir') args.experienceDir = v();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!['ja', 'ko', 'both'].includes(args.lang)) throw new Error('--lang must be ja|ko|both');
  if (!['active', 'proposed', 'none'].includes(args.rules)) throw new Error('--rules must be active|proposed|none');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loaded = await loadSettings();
  const settings = resolveSettings({ ...loaded, loop: { ...loaded.loop, ...(args.maxAttempts ? { maxAttempts: args.maxAttempts } : {}) },
    experience: { ...loaded.experience, ...(args.experienceDir ? { dir: args.experienceDir } : {}), enabled: args.experience && (!args.dry || !!args.experienceDir) } });
  let tasks = await loadTasks(args.tasks);
  if (args.filter) tasks = tasks.filter(t => t.id.includes(args.filter) || t.category === args.filter);
  const out = args.out ?? path.join(REPO_ROOT, 'outputs', 'ai-eval', `${new Date().toISOString().replace(/[:.]/gu, '-')}${args.dry ? '-dry' : ''}`);
  const report = await runEval({ tasks, provider: args.provider ?? settings.providers.default, model: args.model ?? undefined, settings, lang: args.lang, dry: args.dry, rules: args.rules,
    onProgress: c => process.stdout.write(`${c.passed ? 'PASS' : c.status === 'skipped' ? 'SKIP' : 'FAIL'} ${c.id} ${c.status}${c.errorCode ? ` ${c.errorCode}` : ''}\n`) });
  const files = await writeReport(report, out);
  console.log(JSON.stringify({ passRate: report.summary.passRate, passed: report.summary.passed, executed: report.summary.executed, costUsdApprox: report.summary.costEstimate.usd, ...files }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.code ?? error.message); process.exitCode = 1; });
