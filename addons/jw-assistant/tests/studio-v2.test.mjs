import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { studioServer, diffScenes, mockEditScript, entityDetails } from '../tools/studio-server.mjs';
import { describeOp, summarizeOps } from '../ui/studio/ops.mjs';

async function boot(t, { fixture = process.env.FRESCO_JWW_FIXTURE, env = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fresco-studio-v2-')), source = path.join(dir, 'input'), work = path.join(dir, 'work');
  await mkdir(source);
  const original = fixture ? await readFile(fixture) : null;
  if (original) { await writeFile(path.join(source, 'sample.jww'), original); await writeFile(path.join(source, '【自動保存】sample.jw$.jww'), original); }
  const server = await studioServer({ drawingRoot: source, workRoot: work, settingsFile: path.join(dir, 'settings.json'), env });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async route => { const r = await fetch(`${origin}/api/${route}`); return { status: r.status, ...await r.json() }; };
  const boot = await get('v2/bootstrap');
  const post = async (route, data, headers = {}) => {
    const r = await fetch(`${origin}/api/${route}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Fresco-Token': boot.token, ...headers }, body: JSON.stringify(data) });
    return { status: r.status, ...await r.json() };
  };
  return { dir, source, work, origin, get, post, boot, original };
}

test('mock edit script: move / delete / layer / clarification in Japanese, Korean and English', () => {
  const sel = ['e1', 'e2'], run = (instruction, selection = sel) => mockEditScript({ selection, layers: ['0:0', '0:3'] })({ sourceHash: 'h', instruction });
  assert.deepEqual(run('この窓を910右へ').ops, [{ op: 'translate', ids: sel, dx: 910, dy: 0 }]);
  assert.deepEqual(run('선택한 선을 위로 1,820mm 이동').ops[0], { op: 'translate', ids: sel, dx: 0, dy: 1820 });
  assert.equal(run('delete these').ops[0].op, 'delete');
  assert.deepEqual(run('レイヤ 0:3 へ移動').ops[0], { op: 'setLayer', ids: sel, layer: '0:3' });
  assert.match(run('거실 창문 넓혀줘').needsClarification, /넓힐/u);
  assert.match(run('右へ移動').needsClarification, /mm/u);
  assert.match(run('910右へ', []).needsClarification, /選択/u);
  for (const instruction of ['この窓を910右へ', '거실 창문 넓혀줘']) { const p = run(instruction); assert.deepEqual(Object.keys(p).sort(), ['needsClarification', 'ops', 'rationale', 'schemaVersion', 'sourceHash', 'units']); }
});

test('scene diff pairs translated entities and reports removed / added', () => {
  const layers = [{ id: '0:0', scale: 100 }];
  const ent = (id, b) => ({ id, k: 'line', l: 0, c: 2, s: 1, w: 0, b });
  const before = { layers, ents: [ent('e0', [0, 0, 10, 0]), ent('e1', [0, 5, 10, 5])], prims: [{ e: 0, t: 0, l: 0, c: 2, s: 1, p: [0, 0, 10, 0] }, { e: 1, t: 0, l: 0, c: 2, s: 1, p: [0, 5, 10, 5] }] };
  const after = { layers, ents: [ent('e0', [0, 0, 10, 0]), ent('e1', [9.1, 5, 19.1, 5])], prims: [{ e: 0, t: 0, l: 0, c: 2, s: 1, p: [0, 0, 10, 0] }, { e: 1, t: 0, l: 0, c: 2, s: 1, p: [9.1, 5, 19.1, 5] }] };
  const d = diffScenes(before, after, [{ op: 'translate', ids: ['e1'], dx: 910, dy: 0 }]);
  assert.deepEqual(d.removed, [1]); assert.equal(d.added.ents.length, 1); assert.equal(d.added.prims[0].e, 0);
  assert.deepEqual(d.moves, [{ from: 1, to: 0, d: [9.1, 0] }]);
  assert.deepEqual(d.bbox, [0, 5, 19.1, 5]);
  assert.deepEqual(diffScenes(before, before).removed, []);
});

test('op descriptions are human readable in both languages', () => {
  assert.match(describeOp({ op: 'translate', ids: ['e1'], dx: 910, dy: 0 }, 'ja').label, /移動/u);
  assert.match(describeOp({ op: 'translate', ids: ['e1'], dx: 910, dy: 0 }, 'ja').detail, /X \+910/u);
  assert.match(describeOp({ op: 'delete', ids: ['e1', 'e2'] }, 'en').label, /Delete 2/u);
  assert.match(describeOp({ op: 'add', entity: { kind: 'text', text: '洋室', layer: '0:6' } }, 'ja').detail, /洋室/u);
  assert.match(describeOp({ op: 'setLayer', ids: ['e1'], layer: '0:3' }, 'en').detail, /0:3/u);
  assert.equal(summarizeOps([{ op: 'delete', ids: ['a'] }, { op: 'delete', ids: ['b', 'c'] }], 'en'), 'Delete ×2');
  assert.deepEqual(entityDetails({ id: 'e1', kind: 'line', type: 'JwwSen', layer: '1:0', pen: {}, geometry: { start: [0, 0], end: [3, 4] } }, { scale: 50 }).end, [150, 200]);
});

test('v2 endpoints: token/origin/method guards, settings, no-key state, asset whitelist', async t => {
  const { origin, get, post, boot: b } = await boot(t, { fixture: null });
  assert.equal(b.status, 200); assert.equal(b.ai.keys.claude, false); assert.equal(b.ai.keys.openai, false);
  assert.equal(b.ai.dataPolicy.sendRealDrawings, true); assert.equal(typeof b.generator, 'boolean');
  assert.equal((await fetch(`${origin}/api/v2/edit`)).status, 405);
  assert.equal((await post('v2/settings', { provider: 'openai' }, { 'X-Fresco-Token': 'wrong' })).status, 403);
  assert.equal((await post('v2/settings', { provider: 'openai' }, { Origin: 'http://evil.example' })).status, 403);
  const saved = await post('v2/settings', { dataPolicy: { sendRealDrawings: false }, provider: 'openai' });
  assert.equal(saved.status, 200); assert.equal(saved.dataPolicy.sendRealDrawings, false); assert.equal(saved.provider, 'openai');
  assert.equal((await get('v2/settings')).dataPolicy.sendRealDrawings, false);
  assert.equal((await post('v2/settings', { dataPolicy: { sendRealDrawings: 'yes' } })).error, 'E_AI_SETTINGS');
  assert.equal((await post('v2/settings', { apiKey: 'sk-test-should-not-persist' })).status, 200);
  assert.equal((await post('v2/open', { fileId: 'nope' })).error, 'E_FILE_SELECTION');
  assert.equal((await post('v2/edit', { sessionId: 'nope', instruction: 'x' })).error, 'E_SESSION_MISSING');
  assert.equal((await fetch(`${origin}/ui/motion.mjs`)).status, 200);
  assert.equal((await fetch(`${origin}/ui/studio/ops.mjs`)).headers.get('content-security-policy').includes("script-src 'self'"), true);
  assert.equal((await fetch(`${origin}/ui/studio/../../tools/studio-server.mjs`)).status, 404);
  assert.equal((await get('v2/scene?session=x')).error, 'E_SESSION_MISSING');
  const big = await post('v2/edit', { sessionId: 'x', instruction: 'a'.repeat(120000) });
  assert.equal(big.error, 'E_REQUEST_LIMIT');
});

test('v2 real JWW: open scene -> mock edit -> preview diff -> accept new file -> undo; clarification; key-missing; manual patch',
  { skip: !process.env.FRESCO_JWW_FIXTURE, timeout: 240000 }, async t => {
  const { get, post, boot: b, work, source, original } = await boot(t);
  assert.equal(b.files.filter(f => !f.working).length, 1, 'auto-save copies are hidden');
  const opened = await post('v2/open', { fileId: b.files[0].id });
  assert.equal(opened.status, 200); assert.ok(opened.scene.ents.length > 0); assert.ok(opened.scene.prims.length >= opened.scene.ents.length * 0.5);
  assert.equal(opened.scene.units, 'paper-mm'); assert.ok(Array.isArray(opened.scene.bbox));
  assert.ok(opened.scene.layers.length === 256 && opened.scene.layers.some(l => l.count > 0));
  assert.deepEqual(await readdir(work), [], 'opening does not copy or write');
  const line = opened.scene.ents.find(e => e.k === 'line');
  const details = await get(`v2/entity?session=${opened.sessionId}&id=${line.id}`);
  assert.equal(details.kind, 'line'); assert.equal(details.start.length, 2); assert.ok(details.editable.includes('end'));
  const base = { sessionId: opened.sessionId, baseHash: opened.hash };

  const clar = await post('v2/edit', { ...base, instruction: '거실 창문 넓혀줘', selection: [line.id], provider: 'auto' });
  assert.equal(clar.status, 'clarification'); assert.equal(clar.provider, 'mock'); assert.equal(clar.demo, true); assert.match(clar.question, /넓힐/u);
  const noKey = await post('v2/edit', { ...base, instruction: '910右へ', selection: [line.id], provider: 'claude' });
  assert.equal(noKey.status, 'failed'); assert.equal(noKey.error.code, 'E_AI_KEY_REQUIRED'); assert.equal(noKey.error.detail, 'ANTHROPIC_API_KEY');
  assert.equal((await post('v2/edit', { ...base, instruction: 'x', selection: ['e999999'] })).error, 'E_SELECTION');

  const edit = await post('v2/edit', { ...base, instruction: 'この線を910右へ', selection: [line.id], provider: 'mock' });
  assert.equal(edit.status, 'applied', JSON.stringify(edit.error ?? edit.attempts));
  assert.equal(edit.ops[0].op, 'translate'); assert.equal(edit.attempts.length, 1);
  assert.equal(edit.diff.removed.length, 1); assert.equal(edit.diff.added.ents.length, 1); assert.equal(edit.diff.moves.length, 1);
  const scale = opened.scene.layers[line.l].scale || 1;
  assert.ok(Math.abs(edit.diff.moves[0].d[0] - 910 / scale) < 1e-3);
  assert.deepEqual(await readdir(work), [], 'preview does not save');
  assert.equal((await post('v2/accept', { sessionId: opened.sessionId, previewId: 'invented' })).error, 'E_PREVIEW_STALE');
  const accepted = await post('v2/accept', { sessionId: opened.sessionId, previewId: edit.previewId });
  assert.equal(accepted.status, 200); assert.equal(accepted.canUndo, true); assert.equal(accepted.hash, edit.outputHash);
  assert.ok(accepted.savedPath.startsWith(work)); assert.match(path.basename(accepted.savedPath), /^sample-edit-01-[0-9a-f]{6}\.jww$/u);
  assert.deepEqual(await readFile(path.join(source, 'sample.jww')), original, 'original untouched');
  assert.equal((await post('v2/accept', { sessionId: opened.sessionId, previewId: edit.previewId })).error, 'E_PREVIEW_STALE');

  const manual = await post('v2/patch', { sessionId: opened.sessionId, baseHash: accepted.hash,
    patch: { schemaVersion: 2, sourceHash: accepted.hash, units: 'model-mm', rationale: 'inspector', needsClarification: null, ops: [{ op: 'translate', ids: [line.id], dx: -910, dy: 0 }] } });
  assert.equal(manual.status, 'applied'); assert.equal(manual.provider, 'manual');
  assert.equal((await post('v2/patch', { sessionId: opened.sessionId, baseHash: accepted.hash, patch: { schemaVersion: 2, sourceHash: 'stale', units: 'model-mm', rationale: '', needsClarification: null, ops: [] } })).error, 'E_PATCH_STALE');
  assert.equal((await post('v2/reject', { sessionId: opened.sessionId })).rejected, true);

  const undone = await post('v2/undo', { sessionId: opened.sessionId });
  assert.equal(undone.hash, opened.hash); assert.equal(undone.canUndo, false);
  assert.equal((await readdir(work)).length, 1, 'undo keeps the saved file');
  assert.equal((await post('v2/undo', { sessionId: opened.sessionId })).error, 'E_UNDO_EMPTY');
  const listed = await get('v2/files');
  assert.ok(listed.files.some(f => f.working && f.name.startsWith('sample-edit-01')));
});
