import test from 'node:test';
import assert from 'node:assert/strict';
import { springAt, Spring, project, rubberband, rubberClamp, VelocityTracker, animate, setReducedMotion } from '../ui/motion.mjs';

const run = (spring, seconds, dt = 1 / 120) => { const xs = []; for (let t = 0; t < seconds; t += dt) xs.push(spring.step(dt)); return xs; };

test('springs settle on the target for under-, critically and over-damped ratios', () => {
  for (const damping of [0.5, 0.8, 1, 1.6]) {
    const s = new Spring(0, { damping, response: 0.3 }); s.setTarget(100);
    run(s, 3);
    assert.equal(s.value, 100, `damping ${damping}`); assert.equal(s.velocity, 0); assert.ok(s.settled());
  }
});

test('critically damped spring from rest never overshoots and is monotone', () => {
  const s = new Spring(0, { damping: 1, response: 0.4 }); s.setTarget(1);
  let prev = 0;
  for (const x of run(s, 2, 1 / 240)) { assert.ok(x <= 1 + 1e-12, `overshoot ${x}`); assert.ok(x >= prev - 1e-12, 'not monotone'); prev = x; }
});

test('under-damped spring overshoots (sanity) and response controls speed', () => {
  const bouncy = new Spring(0, { damping: 0.5, response: 0.3 }); bouncy.setTarget(1);
  assert.ok(Math.max(...run(bouncy, 1)) > 1.05);
  const fast = springAt(0, 0, 1, 0.1, { damping: 1, response: 0.2 }).x, slow = springAt(0, 0, 1, 0.1, { damping: 1, response: 0.6 }).x;
  assert.ok(fast > slow);
});

test('closed form agrees with fine numeric integration (position and velocity)', () => {
  for (const damping of [0.6, 1, 1.4]) {
    const w0 = 2 * Math.PI / 0.35, k = w0 * w0, c = 2 * damping * w0;
    let x = -40, v = 300; const dt = 1e-5;
    for (let t = 0; t < 0.25; t += dt) { const a = -k * (x - 10) - c * v; v += a * dt; x += v * dt; }
    const exact = springAt(-40, 300, 10, 0.25, { damping, response: 0.35 });
    assert.ok(Math.abs(exact.x - x) < 0.05, `x ${damping}: ${exact.x} vs ${x}`);
    assert.ok(Math.abs(exact.v - v) < 1, `v ${damping}: ${exact.v} vs ${v}`);
  }
});

test('re-targeting mid-flight keeps position and velocity continuous', () => {
  const s = new Spring(0, { damping: 1, response: 0.4 }); s.setTarget(100);
  run(s, 0.12);
  const before = { x: s.value, v: s.velocity };
  s.setTarget(-50);
  assert.equal(s.value, before.x); assert.equal(s.velocity, before.v);
  const tiny = 1e-4, next = springAt(s.value, s.velocity, s.target, tiny, s);
  assert.ok(Math.abs(next.x - before.x) < Math.abs(before.v) * tiny * 1.01 + 1e-9, 'no jump in position');
  assert.ok(Math.abs(next.v - before.v) < 50, 'no velocity brick wall');
  // stepping in many small frames equals one big step (closed form is exact)
  const a = new Spring(5, { damping: 0.8, response: 0.3 }); a.setTarget(20, { velocity: -100 });
  const b = new Spring(5, { damping: 0.8, response: 0.3 }); b.setTarget(20, { velocity: -100 });
  for (let i = 0; i < 10; i++) a.step(0.01);
  b.step(0.1);
  assert.ok(Math.abs(a.value - b.value) < 1e-9 && Math.abs(a.velocity - b.velocity) < 1e-7);
});

test('velocity handoff: a flick moves in its direction before returning', () => {
  const s = new Spring(0, { damping: 1, response: 0.4 }); s.setTarget(0, { velocity: 2000 });
  const xs = run(s, 1);
  assert.ok(Math.max(...xs) > 20); assert.equal(s.value, 0);
});

test('project matches Apple projection and rubberband resists progressively', () => {
  assert.ok(Math.abs(project(1000) - 499) < 1e-9); // (1000/1000)*0.998/0.002
  assert.ok(Math.abs(project(-500, 0.99) + 49.5) < 1e-9);
  assert.equal(rubberband(0, 300), 0);
  const a = rubberband(50, 300), b = rubberband(500, 300), c = rubberband(5000, 300);
  assert.ok(a < 50 && b < 500 && c < 300 / 0.55 * 0.55, 'never exceeds dimension');
  assert.ok((c - b) / 4500 < (b - a) / 450, 'diminishing returns');
  assert.equal(rubberband(-50, 300), -a);
  assert.equal(rubberClamp(5, 0, 10, 100), 5);
  assert.ok(rubberClamp(20, 0, 10, 100) > 10 && rubberClamp(20, 0, 10, 100) < 20);
});

test('velocity tracker reports units per second from recent samples', () => {
  const v = new VelocityTracker(100);
  v.add(0, 0, 0); v.add(10, -5, 10); v.add(20, -10, 20);
  const r = v.velocity(20);
  assert.equal(Math.round(r.x), 1000); assert.equal(Math.round(r.y), -500);
});

test('animate() on a plain object re-targets the running spring and resolves when settled', async () => {
  setReducedMotion(false);
  const obj = { x: 0 };
  const first = animate(obj, { x: 100 }, { damping: 1, response: 0.05 });
  await new Promise(r => setTimeout(r, 30));
  const mid = obj.x;
  assert.ok(mid > 0 && mid < 100);
  const second = animate(obj, { x: -10 }, { damping: 1, response: 0.05 });
  assert.equal(second.springs.x, first.springs.x, 'same spring re-targeted');
  assert.ok(Math.abs(obj.x - mid) < 40);
  assert.equal(await second.finished, true);
  assert.equal(obj.x, -10);
  setReducedMotion(true);
  const jumped = animate(obj, { x: 50 });
  assert.equal(obj.x, 50); await jumped.finished;
  setReducedMotion(false);
});

// ---- wave 2: snapping, scrubbing, odometer, progress ---------------------------------------------------------------
import { detent, nearestStep, magneticSnap, projectSnap, scrubRate, scrubValue } from '../ui/motion.mjs';
import { moveSnap, releaseTarget, MODULE_MM } from '../ui/studio/dragmove.mjs';
import { odometerPlan } from '../ui/studio/odometer.mjs';
import { emptyProgress, reduceProgress } from '../ui/studio/progress.mjs';

test('detent: identity outside, exact at the centre, continuous at the edge, monotone and sticky inside', () => {
  assert.equal(detent(15, 10, 4), 15); assert.equal(detent(10, 10, 4), 10);
  assert.ok(Math.abs(detent(14 - 1e-9, 10, 4) - 14) < 1e-6 && Math.abs(detent(6 + 1e-9, 10, 4) - 6) < 1e-6);
  let prev = -Infinity;
  for (let x = 5; x <= 15; x += 0.01) { const y = detent(x, 10, 4); assert.ok(y >= prev - 1e-12, `not monotone at ${x}`); prev = y; }
  assert.ok(Math.abs(detent(11, 10, 4) - 10) < 0.1, 'sticky core: 1 unit off presents within 0.1');
});

test('magneticSnap picks the nearest step/candidate in reach and reports engagement', () => {
  assert.equal(nearestStep(1300, 455), 1365);
  const far = magneticSnap(700, { step: 455, radius: 100 }); assert.equal(far.target, null); assert.equal(far.value, 700);
  const near = magneticSnap(905, { step: 455, radius: 100 }); assert.equal(near.target, 910); assert.ok(near.engaged); assert.ok(Math.abs(near.value - 910) < 0.1);
  const cand = magneticSnap(905, { step: 455, candidates: [903], radius: 100 }); assert.equal(cand.target, 903);
  const edge = magneticSnap(960, { step: 455, radius: 100 }); assert.equal(edge.target, 910); assert.equal(edge.engaged, false);
});

test('projectSnap: momentum projection then snap to the step nearest the projection, clamped', () => {
  assert.deepEqual(projectSnap(2.2, 0, { step: 1, reach: 1 }), { value: 2, projected: 2.2, snapped: true });
  const flick = projectSnap(3, -10, { step: 1, min: 0, max: 5, rate: 0.99, reach: 1 }); // projects about 3 - 0.99
  assert.equal(flick.value, 2); assert.ok(flick.projected < 3);
  assert.equal(projectSnap(1, -1000, { step: 1, min: 0, max: 5, rate: 0.99, reach: 1 }).value, 0, 'clamped at the first node');
  const free = projectSnap(0, 1000, { min: -50, max: 50 }); assert.equal(free.value, 50); assert.equal(free.snapped, false);
});

test('scrub rate and rubber-banded scrub values', () => {
  assert.equal(scrubRate(1, { shift: true }), 10); assert.ok(Math.abs(scrubRate(1, { alt: true }) - 0.1) < 1e-12);
  assert.deepEqual(scrubValue(10, 5, { perPx: 2 }), { value: 20, raw: 20, over: 0 });
  const over = scrubValue(90, 60, { perPx: 1, max: 100, dimension: 160 });
  assert.equal(over.over, 1); assert.ok(over.value > 100 && over.value < 150, 'resists past the limit'); assert.equal(over.raw, 150);
  const under = scrubValue(1, -100, { perPx: 0.05, min: 0.5 }); assert.equal(under.over, -1); assert.ok(under.value < 0.5 && under.value > -4.5);
  const more = scrubValue(90, 600, { perPx: 1, max: 100, dimension: 160 }); assert.ok(more.value > over.value && more.value < 100 + 160, 'bounded by the dimension');
});

test('moveSnap: 455 module on the translation, endpoints win, Alt is free, release target', () => {
  const scale = 100, zoom = 8; // 1 paper mm = 100 model mm, 8 px per paper mm: snap radius 10px = 1.25 paper mm
  const g = moveSnap({ raw: [4.5, 0.02], scale, zoom }); // 450 model mm, near 455
  assert.equal(g.snap.kind, 'grid'); assert.ok(g.snap.axes.x && g.snap.axes.y); assert.deepEqual(g.snap.target, [MODULE_MM / scale, 0]);
  assert.ok(g.engaged); assert.deepEqual(releaseTarget(g, scale), [4.55, 0]);
  assert.equal(moveSnap({ raw: [9.08, 0], scale, zoom }).snap.major.x, true, '910 is a major module');
  const free = moveSnap({ raw: [4.5, 0.02], scale, zoom, free: true }); assert.equal(free.snap, null); assert.deepEqual(free.d, [4.5, 0.02]);
  const e = moveSnap({ raw: [3, 1], ref: [10, 10], endpoints: [[13.2, 11.1], [40, 40]], scale, zoom });
  assert.equal(e.snap.kind, 'endpoint'); assert.deepEqual(e.snap.point, [13.2, 11.1]); assert.deepEqual(releaseTarget(e, scale).map(v => +v.toFixed(6)), [3.2, 1.1]);
  const open = moveSnap({ raw: [2.7, 1.3], scale, zoom }); assert.equal(open.snap, null); assert.deepEqual(releaseTarget(open, scale), [2.7, 1.3]);
  assert.deepEqual(open.model, [270, 130]);
});

test('odometer plan rolls digits in the direction of change and wraps like a counter', () => {
  const up = odometerPlan('1,819', '1,820');
  assert.equal(up.map(c => c.ch).join(''), '1,820');
  assert.deepEqual(up.at(-1), { ch: '0', digit: true, from: 9, to: 10 }, 'ones wrap 9 to 0 forward');
  assert.deepEqual(up.at(-2), { ch: '2', digit: true, from: 1, to: 2 });
  assert.equal(up[0].from, up[0].to, 'unchanged digits do not roll');
  const down = odometerPlan('780', '779'); assert.deepEqual(down.at(-1), { ch: '9', digit: true, from: 10, to: 9 }); assert.deepEqual(down.at(-2), { ch: '7', digit: true, from: 18, to: 17 });
  const grow = odometerPlan('99', '100'); assert.equal(grow[0].from, null, 'a new leading digit appears');
  assert.equal(odometerPlan('3,640 mm', '3,640 mm').every(c => !c.digit || c.from === c.to), true);
});

test('progress reducer: ordered steps, tool calls, retry with the validator error, final state', () => {
  const evs = [
    { t: 'step', id: 'load', state: 'run', max: 3 }, { t: 'step', id: 'load', state: 'ok', info: { entities: 10, layers: 2 } },
    { t: 'step', id: 'search', state: 'run', attempt: 1 }, { t: 'tool', attempt: 1, name: 'find_text', detail: 'window' },
    { t: 'step', id: 'search', state: 'ok', attempt: 1 }, { t: 'step', id: 'propose', state: 'ok', attempt: 1, info: { ops: 1 } }, { t: 'step', id: 'l1', state: 'run', attempt: 1 },
    { t: 'retry', attempt: 1, code: 'E_PATCH_ENTITY', detail: 'ops[0].ids[0]=e999', layer: 'l1' },
    { t: 'step', id: 'search', state: 'run', attempt: 2 }, { t: 'step', id: 'search', state: 'ok', attempt: 2 }, { t: 'step', id: 'propose', state: 'ok', attempt: 2, info: { ops: 1 } },
    { t: 'step', id: 'l1', state: 'run', attempt: 2 }, { t: 'step', id: 'l1', state: 'ok', attempt: 2 }, { t: 'step', id: 'l2', state: 'run', attempt: 2 },
    { t: 'result', result: { status: 'applied' } }
  ];
  const p = evs.reduce(reduceProgress, emptyProgress());
  assert.deepEqual(p.steps.map(s => `${s.id}${s.attempt || ''}:${s.state}`), ['load:ok', 'search1:ok', 'propose1:ok', 'l11:fail', 'retry1:ok', 'search2:ok', 'propose2:ok', 'l12:ok', 'l22:ok', 'done2:ok']);
  assert.equal(p.steps[1].tools[0].name, 'find_text'); assert.equal(p.steps[1].count, 1);
  assert.equal(p.steps[3].error.code, 'E_PATCH_ENTITY'); assert.equal(p.steps[4].error.detail, 'ops[0].ids[0]=e999');
  assert.equal(p.done, true); assert.equal(p.status, 'applied'); assert.equal(p.attempt, 2); assert.equal(p.max, 3);
  const failed = [{ t: 'step', id: 'load', state: 'run' }, { t: 'error', code: 'E_JWW_EXTERNAL_CHANGE' }].reduce(reduceProgress, emptyProgress());
  assert.deepEqual(failed.steps.map(s => s.state), ['fail', 'fail']); assert.equal(failed.steps[0].error.code, 'E_JWW_EXTERNAL_CHANGE');
});
