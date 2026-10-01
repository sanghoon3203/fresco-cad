// Learning-loop CLI: summarize experience → distill proposed rules → promote after an eval comparison.
//
//   node eval/learn.mjs summarize                         # deterministic stats from the experience dir
//   node eval/learn.mjs distill [--provider claude]       # model proposes generalized rules (status: proposed)
//   node eval/learn.mjs promote <before.json> <after.json> # eval-gated: proposed → active only on improvement
//
// Typical cycle: run-eval --rules active (before) → distill → run-eval --rules proposed (after) → promote.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadSettings } from '../ai/settings.mjs';
import { createExperienceStore } from '../ai/experience.mjs';
import { createProvider } from '../ai/edit-loop.mjs';
import { summarizeExperience, distillRules, promoteRules, loadLearnedRules, saveLearnedRules } from '../ai/rule-learning.mjs';

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const settings = await loadSettings();
  const store = createExperienceStore({ dir: settings.experience.resolvedDir });
  if (command === 'summarize') {
    console.log(JSON.stringify(summarizeExperience(await store.readAll()), null, 2));
  } else if (command === 'distill') {
    const i = rest.indexOf('--provider'), name = i >= 0 ? rest[i + 1] : settings.providers.default;
    const result = await distillRules({ records: await store.readAll(), currentRules: await loadLearnedRules(), provider: createProvider(name, { settings }) });
    if (result.accepted.length) await saveLearnedRules(result.doc);
    console.log(JSON.stringify({ accepted: result.accepted, rejected: result.rejected.length, rejectedReasons: result.rejected.map(r => r.reasons), usage: result.usage }, null, 2));
  } else if (command === 'promote') {
    const [beforeFile, afterFile] = rest;
    if (!beforeFile || !afterFile) throw new Error('usage: promote <before report.json> <after report.json>');
    const [evalBefore, evalAfter] = await Promise.all([beforeFile, afterFile].map(async f => JSON.parse(await readFile(f, 'utf8'))));
    const result = promoteRules({ rulesDoc: await loadLearnedRules(), evalBefore, evalAfter });
    await saveLearnedRules(result.doc);
    console.log(JSON.stringify({ promoted: result.promoted, kept: result.kept, overall: result.overall }, null, 2));
  } else throw new Error('usage: node eval/learn.mjs summarize | distill [--provider name] | promote <before.json> <after.json>');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.code ?? error.message); process.exitCode = 1; });
