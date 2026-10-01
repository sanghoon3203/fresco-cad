import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadTasks, runEval, renderMarkdown, writeReport, resolveCorpusPath, taskCases, parseArgs } from '../eval/run-eval.mjs';
import { resolveSelector, scoreTask, validateTask } from '../eval/checks.mjs';
import { createMockProvider, syntheticIR, clarify } from '../eval/mock.mjs';
import { buildDrawingIndex } from '../ai/context.mjs';
import { createExperienceStore } from '../ai/experience.mjs';

const knowledge = { learnedRules: '', draftingRules: '', layerProfileSummary: '', profile: null, stats: {} };
const noSet = { start: null, end: null, at: null, center: null, radius: null, startAngle: null, sweepAngle: null, text: null, height: null, width: null, angle: null };
const P = (sourceHash, ops) => ({ schemaVersion: 2, sourceHash, units: 'model-mm', ops, rationale: 'mock', needsClarification: null });
async function tmp(t) { const d = await mkdtemp(path.join(tmpdir(), 'fresco-eval-')); t.after(() => rm(d, { recursive: true, force: true })); return d; }

test('the shipped task set: ≥30 valid tasks over the corpus, all categories, Japanese and Korean phrasings', async () => {
  const tasks = await loadTasks();
  assert.ok(tasks.length >= 30, `${tasks.length} tasks`);
  const cats = {}; for (const t of tasks) cats[t.category] = (cats[t.category] ?? 0) + 1;
  for (const c of ['move', 'delete', 'add-line', 'add-text', 'change-text', 'layer', 'clarification']) assert.ok(cats[c] >= 2, c);
  assert.ok(tasks.filter(t => t.instruction_ko).length >= 28);
  assert.ok(tasks.some(t => t.instruction_ko && !t.instruction_ja), 'Korean-only phrasing variants exist');
  assert.ok(new Set(tasks.map(t => path.basename(t.file))).size >= 3);
  for (const t of tasks) for (const c of t.expect) assert.ok(!JSON.stringify(c).match(/"e\d+"/u), `${t.id}: checks must not use raw ids`);
  assert.throws(() => validateTask({ id: 'x', file: 'f', instruction_ja: 'a', expect: [{ type: 'magic' }] }), e => e.code === 'E_EVAL_TASK');
  assert.deepEqual(taskCases(tasks.find(t => t.id === 'wood-ko-move-bath')).map(c => c.lang), ['ko']);
});

test('corpus paths can be relocated with FRESCO_JWW_CORPUS', () => {
  assert.equal(resolveCorpusPath('C:/JWW/Test1.jww', {}), 'C:/JWW/Test1.jww');
  assert.equal(resolveCorpusPath('C:/JWW/木造平面例.jww', { FRESCO_JWW_CORPUS: 'D:\\corpus\\' }), 'D:\\corpus/木造平面例.jww');
  assert.deepEqual(parseArgs(['--dry', '--lang', 'ko', '--rules', 'proposed', '--filter', 'apt-']).rules, 'proposed');
  assert.throws(() => parseArgs(['--lang', 'fr']));
});

test('checks score geometry, not ids: a copy is not a move, edits outside the box are caught', () => {
  const ir = syntheticIR(), before = buildDrawingIndex(ir);
  const moved = structuredClone(ir); moved.entities[4].geometry.anchor[0] += 3; moved.entities[4].sourceProperties.m_end_x += 3; moved.sourceHash = 'x';
  const copied = structuredClone(ir); copied.entities.push({ ...structuredClone(moved.entities[4]), id: 'e99' });
  const task = { expect: [{ type: 'entityMoved', selector: { kind: 'text', text: '洋室' }, dx: 300, dy: 0 }, { type: 'noChangeOutside', bbox: [1000, 1000, 2500, 1800] }] };
  const ok = scoreTask(task, { before, after: buildDrawingIndex(moved), result: { status: 'applied' } });
  assert.equal(ok.passed, true, JSON.stringify(ok.checks));
  const copy = scoreTask(task, { before, after: buildDrawingIndex(copied), result: { status: 'applied' } });
  assert.equal(copy.passed, false); assert.match(copy.checks[1].detail, /still at origin/u);
  const outside = structuredClone(moved); outside.entities[5].geometry.anchor[1] += 1;
  assert.equal(scoreTask(task, { before, after: buildDrawingIndex(outside), result: { status: 'applied' } }).checks[2].passed, false);
  const failed = scoreTask(task, { before, after: null, result: { status: 'failed' } });
  assert.equal(failed.score, 0);
  assert.equal(scoreTask({ expect: [{ type: 'clarificationExpected' }] }, { before, after: null, result: { status: 'clarification' } }).passed, true);
  assert.deepEqual(resolveSelector(before, { kind: 'line', layer: '0:1', start: [3640, 0], end: [0, 0] }).map(e => e.id), ['e0']);
  assert.deepEqual(resolveSelector(before, { kind: 'text', near: [5000, 1300], radius: 50 }).map(e => e.id), ['e5']);
});

test('runEval with a scripted provider + simulated apply: scoring, report files, experience records', async t => {
  const dir = await tmp(t), tasksDir = path.join(dir, 'tasks'); await mkdir(tasksDir);
  const tasks = [
    { id: 'syn-move', category: 'move', file: 'C:/JWW/synthetic.jww', instruction_ja: '洋室を右に300mm移動', instruction_ko: '洋室 글자를 오른쪽으로 300mm 옮겨줘',
      expect: [{ type: 'entityMoved', selector: { kind: 'text', text: '洋室' }, dx: 300, dy: 0 }, { type: 'entityCountDelta', delta: 0 }] },
    { id: 'syn-rename', category: 'change-text', file: 'C:/JWW/synthetic.jww', instruction_ja: 'リビングをLDKに変更', expect: [{ type: 'textExists', text: 'LDK', layer: '0:6', near: [5000, 1300], radius: 300 }, { type: 'textAbsent', text: 'リビング' }] },
    { id: 'syn-line', category: 'add-line', file: 'C:/JWW/synthetic.jww', instruction_ja: '(0,-1000)から(3640,-1000)に線', expect: [{ type: 'lineExists', start: [0, -1000], end: [3640, -1000], layer: '0:1' }] },
    { id: 'syn-ask', category: 'clarification', file: 'C:/JWW/synthetic.jww', instruction_ja: '壁を少し厚く', expect: [{ type: 'clarificationExpected' }] },
    { id: 'syn-missing', category: 'move', file: 'C:/JWW/missing.jww', instruction_ja: 'x', expect: [{ type: 'clarificationExpected' }] }
  ];
  await writeFile(path.join(tasksDir, 'syn.json'), JSON.stringify(tasks));
  const loaded = await loadTasks(tasksDir);
  const ir = syntheticIR();
  const provider = createMockProvider({ script: ({ instruction, sourceHash, runTool }) => {
    if (instruction.includes('LDK')) return P(sourceHash, [{ op: 'modify', id: JSON.parse(runTool('find_text', { query: 'リビング', limit: null }).content).items[0].id, set: { ...noSet, text: 'LDK' } }]);
    if (instruction.includes('線')) return P(sourceHash, [{ op: 'add', tempId: null, entity: { kind: 'line', layer: '0:1', start: [0, -1000], end: [3640, -1001], pen: { color: null, style: null, width: null } } }]);
    if (instruction.includes('300')) return P(sourceHash, [{ op: 'translate', ids: ['e4'], dx: 300, dy: instruction.includes('옮겨') ? 50 : 0 }]); // ko case is wrong on purpose
    return clarify(sourceHash);
  } });
  const store = createExperienceStore({ dir: path.join(dir, 'exp'), env: {} });
  const report = await runEval({ tasks: loaded, provider, settings: {}, deps: { experience: store, knowledge, checkPatchLayers: null,
    readBytes: async p => { if (!p.endsWith('synthetic.jww')) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return Buffer.from('synthetic'); }, loadIR: async () => ir,
    applyPatchV2: async (bytes, patch, opts) => (await import('../eval/mock.mjs')).createSimulatedApply(async () => ir)(bytes, patch, opts) } });
  const by = Object.fromEntries(report.tasks.map(c => [c.id, c]));
  assert.equal(by['syn-move#ja'].passed, true);
  assert.equal(by['syn-move#ko'].passed, false, 'dy=50 is not the requested move');
  assert.equal(by['syn-rename#ja'].passed, true);
  assert.equal(by['syn-line#ja'].passed, true, 'lineExists tolerates 1 mm');
  assert.equal(by['syn-ask#ja'].passed, true);
  assert.equal(by['syn-missing#ja'].status, 'skipped');
  assert.deepEqual([report.summary.executed, report.summary.passed, report.summary.skipped], [5, 4, 1]);
  assert.equal(report.summary.byCategory.move.passRate, 0.5);
  assert.deepEqual(by['syn-move#ja'].patterns.includes('move'), true);
  const files = await writeReport(report, path.join(dir, 'out'));
  const md = await readFile(files.md, 'utf8');
  assert.match(md, /\| syn-move#ko \| applied \| no \|/u);
  assert.match(md, /approximate/u);
  assert.equal(JSON.parse(await readFile(files.json, 'utf8')).summary.passed, 4);
  const recs = await store.readAll();
  assert.ok(recs.filter(r => r.type === 'attempt').every(r => typeof r.evalTaskId === 'string' && r.evalTaskId.includes('#')));
});

test('--dry mode uses the probing mock provider (no keys, no network): clarification tasks pass, edits fail', async () => {
  const ir = syntheticIR();
  const tasks = [
    { id: 'a', category: 'clarification', file: 'C:/JWW/s.jww', instruction_ja: '窓をずらして', expect: [{ type: 'clarificationExpected' }] },
    { id: 'b', category: 'move', file: 'C:/JWW/s.jww', instruction_ja: '洋室を右に300mm移動', expect: [{ type: 'entityMoved', selector: { kind: 'text', text: '洋室' }, dx: 300, dy: 0 }] }
  ].map(validateTask);
  let fetched = 0;
  const report = await runEval({ tasks, dry: true, settings: {}, deps: { env: {}, fetch: async () => { fetched++; }, knowledge, checkPatchLayers: null, readBytes: async () => Buffer.from('s'), loadIR: async () => ir } });
  assert.equal(fetched, 0);
  assert.equal(report.provider, 'mock'); assert.equal(report.dry, true);
  assert.deepEqual(report.tasks.map(c => c.passed), [true, false]);
  assert.match(renderMarkdown(report), /\(dry\)/u);
});

const fixture = process.env.FRESCO_JWW_FIXTURE;
test('task selectors resolve on the corpus drawing used as fixture', { skip: !fixture, timeout: 300000 }, async () => {
  const [{ readJww }, { toIR }] = await Promise.all([import('../native/jww.mjs'), import('../native/jww-pipeline.mjs')]);
  const tasks = (await loadTasks()).filter(t => path.basename(t.file).toLowerCase() === path.basename(fixture).toLowerCase());
  if (!tasks.length) return;
  const bytes = await readFile(fixture), before = buildDrawingIndex(toIR(bytes, await readJww(bytes)));
  for (const t of tasks) for (const c of t.expect) if (c.selector) assert.ok(resolveSelector(before, c.selector).length >= 1, `${t.id} selector`);
  // Oracle-free sanity: every edit task's checks fail on the unedited drawing (they test a real change).
  for (const t of tasks.filter(x => x.category !== 'clarification')) assert.equal(scoreTask(t, { before, after: before, result: { status: 'applied' } }).passed, false, t.id);
});
