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
