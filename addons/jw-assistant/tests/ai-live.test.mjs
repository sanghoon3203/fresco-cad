// Live integration: real provider API + real JWW engine. Skipped unless FRESCO_AI_LIVE=1 and the provider key is set.
//   FRESCO_AI_LIVE=1 ANTHROPIC_API_KEY=... [FRESCO_AI_LIVE_PROVIDER=claude|claude-fast|openai] [FRESCO_JWW_CORPUS=C:/JWW] node --test tests/ai-live.test.mjs
// Costs real money (a few cents per task). Experience is not recorded by this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { loadTasks, runEval, resolveCorpusPath } from '../eval/run-eval.mjs';
import { resolveSettings } from '../ai/settings.mjs';

const provider = process.env.FRESCO_AI_LIVE_PROVIDER ?? 'claude';
const keyName = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
const enabled = process.env.FRESCO_AI_LIVE === '1' && !!process.env[keyName];

test(`live: ${provider} solves a move task and asks on an ambiguous one`, { skip: !enabled && `set FRESCO_AI_LIVE=1 and ${keyName}`, timeout: 900000 }, async () => {
  const tasks = (await loadTasks()).filter(t => ['wood-move-washitsu', 'wood-clarify-wall'].includes(t.id));
  await access(resolveCorpusPath(tasks[0].file));
  const report = await runEval({ tasks, provider, lang: 'ja', settings: resolveSettings({ loop: { maxAttempts: 2 } }), deps: { experience: false } });
  const by = Object.fromEntries(report.tasks.map(c => [c.taskId, c]));
  console.log(JSON.stringify(report.summary, null, 2));
  assert.equal(by['wood-clarify-wall'].status, 'clarification');
  assert.equal(by['wood-move-washitsu'].passed, true, JSON.stringify(by['wood-move-washitsu']));
  assert.ok(report.summary.usage.requests > 0);
});
