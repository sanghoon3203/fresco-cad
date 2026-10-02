import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hash, readJww, readJwwOneShot } from '../native/jww.mjs';
import { toIR } from '../native/jww-pipeline.mjs';
import { validatePatchV2 } from '../core/patch-v2.mjs';
import { decodeJww, SPAN } from '../native/codec/jww-codec.mjs';
import { applyPatchV2, finalizePatchV2, planNativeOps } from '../native/jww-edit.mjs';
import { verifyL2, verifyL3, codecDocument, tagLength, classTagProblems } from '../native/verify.mjs';
import { JwwWorker, entityDigest, isWorkerInfraError } from '../native/jww-worker.mjs';
import { drawPlan } from '../generator/draw-plan.mjs';

// ---- a JWW produced by our own generator: no DLL needed for L1/L2 -------------------------------------------------------
const plan1 = JSON.parse(await readFile(new URL('../generator/examples/plan-1ldk-46.json', import.meta.url), 'utf8'));
const bytes = Buffer.from(drawPlan(plan1).bytes);
const source = decodeJww(bytes), view = codecDocument(source), ir = toIR(bytes, view);
const lineIndex = view.entities.findIndex(e => e.type === 'JwwSen'), lineId = `e${lineIndex}`;
const patchFor = (b, ops) => ({ schemaVersion: 2, sourceHash: hash(b), units: 'model-mm', ops, rationale: 'test', needsClarification: null });
const ops = [{ op: 'translate', ids: [lineId], dx: 910, dy: 0 }];
const textAdd = { op: 'add', tempId: 'n0', entity: { kind: 'text', layer: '1:0', at: [0, 0], text: '洋室 6帖', height: null, width: null, spacing: null, angle: null, style: null, color: null } };
const codecPlan = o => planNativeOps(view, validatePatchV2(patchFor(bytes, o), ir).ops, { header: source.header });
const failed = r => r.checks.filter(c => !c.ok).map(c => c.id);
// m_start_x of a CDataSen record: tag, then u32 group, u8 style, u16 color/width/layer/glayer/flag (15 bytes).
const startX = (buf, e) => e[SPAN][0] + tagLength(buf, e[SPAN][0]) + 15;

test('preview level runs L1+L2 only, records the levels, and keeps untouched bytes', async () => {
  const r = await applyPatchV2(bytes, patchFor(bytes, [...ops, textAdd]), { ir, level: 'preview' });
  assert.deepEqual(r.receipt.verifiedLevels, ['L1', 'L2']); assert.equal(r.receipt.level, 'preview'); assert.equal(r.receipt.finalized, false);
  for (const v of r.receipt.verification) { assert.equal(v.ok, true, JSON.stringify(v)); assert.ok(v.durationMs >= 0); assert.ok(v.checks.length > 0); }
  assert.deepEqual(r.receipt.verification[1].checks.map(c => c.id), ['apply-encode', 'source-decode', 'output-decode', 'reencode-stable', 'class-tags', 'byte-exact-outside-edits', 'semantic']);
  assert.equal(r.receipt.byteExactOutsideEdits, true);
  assert.equal(r.ir.entities.length, ir.entities.length + 1);
  await assert.rejects(applyPatchV2(bytes, patchFor(bytes, ops), { ir, level: 'quick' }), err => err.code === 'E_JWW_LEVEL');
});

test('L1 failures keep their codes and carry the L1 result', async () => {
  await assert.rejects(applyPatchV2(bytes, patchFor(bytes, [{ op: 'delete', ids: ['e999999'] }]), { ir, level: 'preview' }),
    err => err.code === 'E_PATCH_ENTITY' && err.verification?.[0]?.level === 'L1' && err.verification[0].ok === false);
  await assert.rejects(applyPatchV2(bytes, patchFor(bytes, [{ ...textAdd, entity: { ...textAdd.entity, text: 'a😀' } }]), { ir, level: 'preview' }),
    err => err.code === 'E_JWW_TEXT_CHAR' && err.verification[0].checks.some(c => c.id === 'engine-plan' && !c.ok));
});

test('L2 catches a wrong coordinate in the edited entity', async () => {
  const plan = codecPlan(ops), good = (await applyPatchV2(bytes, patchFor(bytes, ops), { ir, level: 'preview' })).bytes;
  assert.equal((await verifyL2(bytes, good, plan)).result.ok, true);
  const bad = Buffer.from(good), e = decodeJww(good).entities[lineIndex];
  bad.writeDoubleLE(bad.readDoubleLE(startX(bad, e)) + 0.5, startX(bad, e));
  const { result } = await verifyL2(bytes, bad, plan);
  assert.equal(result.ok, false); assert.deepEqual(failed(result), ['semantic']);
  assert.match(result.checks.find(c => c.id === 'semantic').detail, new RegExp(`${lineId}\\(was ${lineId}\\)\\.m_start_x`, 'u'));
});

test('L2 catches a byte changed outside the edit', async () => {
  const plan = codecPlan(ops), good = (await applyPatchV2(bytes, patchFor(bytes, ops), { ir, level: 'preview' })).bytes;
  const other = view.entities.findIndex((x, i) => x.type === 'JwwSen' && i !== lineIndex), bad = Buffer.from(good), e = decodeJww(good).entities[other];
  bad[startX(bad, e) + 7] ^= 0x01; // flips a bit of an untouched line's m_start_x
  const { result } = await verifyL2(bytes, bad, plan);
  assert.equal(result.ok, false); assert.ok(failed(result).includes('byte-exact-outside-edits')); assert.ok(failed(result).includes('semantic'));
  // header bytes too
  const hdr = Buffer.from(good); hdr[source.spans.header[0] + 40] ^= 0x01;
  assert.ok(failed((await verifyL2(bytes, hdr, plan)).result).includes('byte-exact-outside-edits'));
});

test('L2 catches a broken MFC class tag', async () => {
  const plan = codecPlan(ops), good = (await applyPatchV2(bytes, patchFor(bytes, ops), { ir, level: 'preview' })).bytes, out = decodeJww(good);
  // A class reference (0x8000|pid) of an untouched record re-pointed at a different class.
  const pids = new Map(); let pid = 1;
  for (const e of out.entities) { const at = e[SPAN][0]; if (good.readUInt16LE(at) === 0xffff) pids.set(e.cls, pid++); pid++; }
  const victim = out.entities.find((e, i) => i !== lineIndex && good.readUInt16LE(e[SPAN][0]) !== 0xffff && pids.size > 1);
  const otherClass = [...pids].find(([cls]) => cls !== victim.cls);
  assert.ok(otherClass, 'fixture needs two classes');
  const bad = Buffer.from(good); bad.writeUInt16LE(0x8000 | otherClass[1], victim[SPAN][0]);
  const { result } = await verifyL2(bytes, bad, plan);
  assert.equal(result.ok, false);
  assert.ok(failed(result).some(id => ['output-decode', 'class-tags', 'semantic', 'exception'].includes(id)), JSON.stringify(result.checks));
  // The canonical tag sequence of an untouched output is accepted.
  assert.deepEqual(classTagProblems(good, out, source.schemas).problems, []);
});

// ---- worker protocol with a fake worker ------------------------------------------------------------------------------
const FAKE = `
const rl = require('node:readline').createInterface({ input: process.stdin });
if (process.env.FAKE_NO_READY !== '1') process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, protocol: 1 }) + '\\n');
rl.on('line', line => {
  const r = JSON.parse(line);
  if (r.cmd === 'crash') process.exit(3);
  if (r.cmd === 'hang') return;
  if (r.cmd === 'shutdown') { process.stdout.write(JSON.stringify({ id: r.id, ok: true, result: null }) + '\\n'); process.exit(0); }
  if (r.cmd === 'fail') return process.stdout.write(JSON.stringify({ id: r.id, ok: false, error: { code: 'E_JWW_NATIVE_READ', message: 'bad file' } }) + '\\n');
  if (r.cmd === 'big') return process.stdout.write(JSON.stringify({ id: r.id, ok: true, result: 'x'.repeat(3e6) }) + '\\n');
  setTimeout(() => process.stdout.write(JSON.stringify({ id: r.id, ok: true, result: { echo: r.value, pid: process.pid } }) + '\\n'), 5);
});`;
const fake = (options = {}) => new JwwWorker({ command: process.execPath, args: ['-e', FAKE], startTimeoutMs: 5000, requestTimeoutMs: 2000, ...options });

test('worker protocol: ids, ordering, large lines, errors, timeout, crash restart, bounded queue, shutdown', { timeout: 60000 }, async () => {
  const w = fake({ maxQueue: 3 });
  try {
    const results = await Promise.all([1, 2, 3].map(v => w.request('echo', { value: v })));
    assert.deepEqual(results.map(r => r.echo), [1, 2, 3]);
    const pid = results[0].pid;
    assert.equal((await w.request('big')).length, 3e6);
    await assert.rejects(w.request('fail'), err => err.code === 'E_JWW_NATIVE_READ' && err.fromWorker && !isWorkerInfraError(err));
    // bounded queue: at most 3 requests may wait (checked synchronously, before dispatch)
    const many = [0, 1, 2, 3, 4].map(v => w.request('echo', { value: v }).then(r => r.echo, e => e.code));
    assert.deepEqual(await Promise.all(many), [0, 1, 2, 'E_JWW_WORKER_QUEUE_FULL', 'E_JWW_WORKER_QUEUE_FULL']);
    // timeout kills the worker; the next request restarts it
    await assert.rejects(w.request('hang', {}, { timeoutMs: 300 }), err => err.code === 'E_JWW_WORKER_TIMEOUT' && isWorkerInfraError(err));
    const after = await w.request('echo', { value: 'x' }); assert.notEqual(after.pid, pid);
    // crash: the in-flight request fails, queued work continues on a restarted worker
    const [crashed, queued] = await Promise.allSettled([w.request('crash'), w.request('echo', { value: 'y' })]);
    assert.equal(crashed.reason.code, 'E_JWW_WORKER_CRASH'); assert.equal(queued.value.echo, 'y'); assert.notEqual(queued.value.pid, after.pid);
    assert.equal(w.stats.timeouts, 1); assert.equal(w.stats.crashes, 1); assert.equal(w.stats.starts, 3);
  } finally { await w.close(); }
  await assert.rejects(w.request('echo'), err => err.code === 'E_JWW_WORKER_CLOSED');
});

test('worker protocol: restart storm -> cool-down (callers fall back); missing ready line -> start error', { timeout: 60000 }, async () => {
  const w = fake({ maxRestarts: 1, cooldownMs: 60000 });
  try {
    await assert.rejects(w.request('crash'), err => err.code === 'E_JWW_WORKER_CRASH');
    await assert.rejects(w.request('crash'), err => err.code === 'E_JWW_WORKER_CRASH');
    await assert.rejects(w.request('echo'), err => err.code === 'E_JWW_WORKER_UNAVAILABLE');
    await assert.rejects(w.request('echo'), err => err.code === 'E_JWW_WORKER_UNAVAILABLE' && isWorkerInfraError(err));
  } finally { await w.close(); }
  const silent = fake({ startTimeoutMs: 500, env: { ...process.env, FAKE_NO_READY: '1' } });
  try { await assert.rejects(silent.request('echo'), err => err.code === 'E_JWW_WORKER_START'); } finally { await silent.close(); }
});

// ---- real DLL (Windows + fixture) -----------------------------------------------------------------------------------------
const fixture = process.env.FRESCO_JWW_FIXTURE, native = { skip: !fixture || process.platform !== 'win32', timeout: 300000 };

test('native: worker read equals the one-shot reader; digests agree with the worker', native, async () => {
  const b = await readFile(fixture), one = await readJwwOneShot(b), viaWorker = await readJww(b);
  assert.deepEqual(viaWorker, one);
  // A no-op "edit" plan: every entity untouched, so L3 must find zero digest mismatches.
  const expected = one.entities.map(e => ({ from: e.id, type: e.type, props: e.props, touched: false, components: e.components }));
  assert.equal(new Set(expected.map(entityDigest)).size > 1, true);
  const { result } = await verifyL3(b, { expected }, { before: one, codec: true });
  assert.equal(result.ok, true, JSON.stringify(result.checks)); assert.match(result.checks[0].detail, /^worker: .* 0 shipped, 0 digest mismatches/u);
});

test('native: save level adds L3; L3 catches a corrupted output; finalize checks the previewed bytes', native, async () => {
  const b = await readFile(fixture), document = await readJww(b), fixIr = toIR(b, document), i = document.entities.findIndex(e => e.type === 'JwwSen');
  const patch = patchFor(b, [{ op: 'translate', ids: [`e${i}`], dx: 455, dy: 0 }]);
  const preview = await applyPatchV2(b, patch, { ir: fixIr, document, level: 'preview' });
  const saved = await finalizePatchV2(b, patch, preview.bytes, { ir: fixIr, document });
  assert.deepEqual(saved.receipt.verifiedLevels, ['L1', 'L2', 'L3']); assert.equal(saved.receipt.finalized, true);
  assert.ok(saved.receipt.verification.every(v => v.ok));
  await assert.rejects(finalizePatchV2(b, patch, Buffer.concat([preview.bytes, Buffer.of(0)]), { ir: fixIr, document }), err => err.code === 'E_JWW_SAVE_MISMATCH');
  // Corrupt an untouched line in the output: the independent DLL read must disagree with the plan.
  const plan = planNativeOps(document, validatePatchV2(patch, fixIr).ops, {});
  const out = decodeJww(preview.bytes), j = document.entities.findIndex((e, k) => e.type === 'JwwSen' && k !== i), bad = Buffer.from(preview.bytes);
  bad.writeDoubleLE(bad.readDoubleLE(startX(bad, out.entities[j])) + 1, startX(bad, out.entities[j]));
  const { result } = await verifyL3(bad, plan, { before: document, codec: true });
  assert.equal(result.ok, false); assert.match(result.checks.find(c => c.id === 'dll-vs-plan').detail, new RegExp(`e${j}\\(was e${j}\\)\\.m_start_x`, 'u'));
});

test('native: real JwwHelper worker survives a timeout (restart) and serves again', native, async () => {
  const w = new JwwWorker({ requestTimeoutMs: 60000 }), dir = await mkdtemp(path.join(tmpdir(), 'fresco-verify-'));
  try {
    assert.equal(await w.request('ping'), 'pong');
    await assert.rejects(w.request('sleep', { ms: 5000 }, { timeoutMs: 300 }), err => err.code === 'E_JWW_WORKER_TIMEOUT');
    const file = path.join(dir, 'a.jww'); await writeFile(file, await readFile(fixture));
    const doc = await w.request('read', { path: file });
    assert.ok(doc.entities.length > 0); assert.equal(w.stats.starts, 2);
    await assert.rejects(w.request('read', { path: path.join(dir, 'missing.jww') }), err => err.fromWorker && !isWorkerInfraError(err));
  } finally { await w.close(); await rm(dir, { recursive: true, force: true }); }
});
