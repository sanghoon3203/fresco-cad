// Tiny dependency-free spring engine for the Studio UI.
// Apple-style parameters: `damping` (ratio, 1 = critically damped, <1 bounces) and `response` (seconds, the undamped
// period: lower = snappier; not a duration). Springs are integrated with the closed-form solution of a unit-mass damped
// oscillator, so any frame time is exact, and every animation starts from the *presented* value with the current
// velocity — re-targeting mid-flight is continuous in both position and velocity.
// Works in Node (pure math, used by tests) and in the browser (rAF ticker, element transforms).

const TAU = Math.PI * 2;
export const SPRINGS = Object.freeze({
  default: { damping: 1, response: 0.35 },   // most UI: no overshoot
  move: { damping: 1, response: 0.4 },       // reposition / camera
  snappy: { damping: 1, response: 0.22 },    // small controls
  sheet: { damping: 0.86, response: 0.32 },  // sheets/drawers (a hint of life)
  flick: { damping: 0.8, response: 0.35 },   // only after a gesture carried momentum
  check: { damping: 0.62, response: 0.28 }   // the layer toggle checkmark
});

/** Exact state of a damped spring after `t` seconds. x/v are the value and velocity; returns {x, v}. */
export function springAt(x0, v0, target, t, { damping = 1, response = 0.35 } = {}) {
  const w0 = TAU / Math.max(response, 1e-4), z = Math.max(damping, 0), d0 = x0 - target;
  if (t <= 0) return { x: x0, v: v0 };
  let d, v;
  if (Math.abs(z - 1) < 1e-6) {
    const e = Math.exp(-w0 * t), b = v0 + w0 * d0;
    d = e * (d0 + b * t); v = e * (v0 - w0 * b * t);
  } else if (z < 1) {
    const wd = w0 * Math.sqrt(1 - z * z), e = Math.exp(-z * w0 * t), c = Math.cos(wd * t), s = Math.sin(wd * t), b = (v0 + z * w0 * d0) / wd;
    d = e * (d0 * c + b * s);
    v = -z * w0 * d + e * wd * (b * c - d0 * s); // d/dt of e·(d0·c + b·s)
  } else {
    const r = Math.sqrt(z * z - 1), r1 = -w0 * (z - r), r2 = -w0 * (z + r), c2 = (v0 - r1 * d0) / (r2 - r1), c1 = d0 - c2;
    const e1 = Math.exp(r1 * t), e2 = Math.exp(r2 * t);
    d = c1 * e1 + c2 * e2; v = c1 * r1 * e1 + c2 * r2 * e2;
  }
  return { x: target + d, v };
}

/** One spring on one scalar. Re-targeting keeps the current value and velocity (no seams, no brick walls). */
export class Spring {
  constructor(value = 0, { damping = 1, response = 0.35, restDelta = 0.001, restSpeed = 0.01 } = {}) {
    this.value = value; this.velocity = 0; this.target = value;
    this.damping = damping; this.response = response; this.restDelta = restDelta; this.restSpeed = restSpeed;
  }
  /** Change the destination; optionally replace the velocity (velocity handoff from a gesture, units/second). */
  setTarget(target, { velocity, damping, response } = {}) {
    if (Number.isFinite(velocity)) this.velocity = velocity;
    if (Number.isFinite(damping)) this.damping = damping;
    if (Number.isFinite(response)) this.response = response;
    this.target = target;
    return this;
  }
  /** Hard set (no animation): the presented value jumps, velocity resets. */
  jump(value) { this.value = this.target = value; this.velocity = 0; return this; }
  step(dt) {
    const s = springAt(this.value, this.velocity, this.target, dt, this);
    this.value = s.x; this.velocity = s.v;
    if (this.settled()) { this.value = this.target; this.velocity = 0; }
    return this.value;
  }
  settled() { return Math.abs(this.value - this.target) <= this.restDelta && Math.abs(this.velocity) <= this.restSpeed; }
}

/** Apple's momentum projection: distance a flick travels under exponential deceleration. velocity in units/s. */
export function project(velocity, decelerationRate = 0.998) {
  return (velocity / 1000) * decelerationRate / (1 - decelerationRate);
}

/** Progressive resistance past a boundary. Returns the displayed overshoot for a raw overshoot. */
export function rubberband(overshoot, dimension, constant = 0.55) {
  if (!dimension) return 0;
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** Clamp `value` into [min, max] with rubber-banding outside (dimension = visible size used as the scale). */
export function rubberClamp(value, min, max, dimension, constant = 0.55) {
  if (value < min) return min + rubberband(value - min, dimension, constant);
  if (value > max) return max + rubberband(value - max, dimension, constant);
  return value;
}

/** Pointer velocity from a short history (last ~100 ms), in units per second. */
export class VelocityTracker {
  constructor(windowMs = 100) { this.windowMs = windowMs; this.samples = []; }
  reset() { this.samples.length = 0; }
  add(x, y, t = now()) {
    this.samples.push({ x, y, t });
    while (this.samples.length > 2 && t - this.samples[0].t > this.windowMs) this.samples.shift();
  }
  velocity(t = now()) {
    const s = this.samples.filter(p => t - p.t <= this.windowMs * 1.5);
    if (s.length < 2) return { x: 0, y: 0 };
    const a = s[0], b = s.at(-1), dt = (b.t - a.t) / 1000;
    if (dt <= 0) return { x: 0, y: 0 };
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
  }
}

// ---- reduced motion -------------------------------------------------------------------------------------------------
const MOTION_KEY = 'fresco-jw-assistant-reduce-motion'; // shared with the review UI setting
let appReduced = false;
export function setReducedMotion(value) { appReduced = !!value; }
export function prefersReducedMotion() {
  if (appReduced) return true;
  try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
export function readStoredReducedMotion() { try { return globalThis.localStorage?.getItem(MOTION_KEY) === 'true'; } catch { return false; } }
export function storeReducedMotion(value) { try { globalThis.localStorage?.setItem(MOTION_KEY, String(!!value)); } catch {} setReducedMotion(value); }

// ---- ticker -----------------------------------------------------------------------------------------------------------
const now = () => globalThis.performance?.now?.() ?? Date.now();
const active = new Set();
let frame = 0, last = 0;
// rAF is the clock; a watchdog timer keeps springs converging when the page is not painting (background window),
// so state never gets stuck mid-animation. Whichever fires first runs the frame.
const raf = cb => {
  let done = false;
  const run = t => { if (done) return; done = true; cb(t ?? now()); };
  if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(run);
  setTimeout(() => run(now()), globalThis.requestAnimationFrame ? 100 : 16);
  return 1;
};
function tick(t) {
  const dt = Math.min(Math.max((t - last) / 1000, 0), 1 / 15); // a hidden tab must not teleport a spring
  last = t; frame = 0;
  for (const anim of [...active]) anim._step(dt);
  if (active.size) { frame = raf(tick); }
}
function schedule(anim) {
  active.add(anim);
  if (!frame) { last = now(); frame = raf(tick); }
}

// ---- animate ------------------------------------------------------------------------------------------------------------
const registry = new WeakMap(); // target -> Map(prop -> Animation) so a new animate() re-targets the running spring
const isElement = t => typeof globalThis.Element === 'function' && t instanceof globalThis.Element;
const TRANSFORM_PROPS = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate'];
const DEFAULTS = { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotate: 0, opacity: 1 };

function elementState(el) { return el.__motion ??= { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotate: 0, opacity: Number(getComputedStyle(el).opacity) || 1 }; }
function writeElement(el, state) {
  const parts = [];
  if (state.x || state.y) parts.push(`translate3d(${state.x.toFixed(2)}px, ${state.y.toFixed(2)}px, 0)`);
  if (state.scale !== 1) parts.push(`scale(${state.scale.toFixed(4)})`);
  if (state.scaleX !== 1 || state.scaleY !== 1) parts.push(`scale(${state.scaleX.toFixed(4)}, ${state.scaleY.toFixed(4)})`);
  if (state.rotate) parts.push(`rotate(${state.rotate.toFixed(2)}deg)`);
  el.style.transform = parts.join(' ');
  if ('opacity' in state) el.style.opacity = String(Math.round(state.opacity * 1000) / 1000);
}

class Animation {
  constructor(target, prop, spring, write) { this.target = target; this.prop = prop; this.spring = spring; this.write = write; this.listeners = []; this.done = false; }
  _step(dt) {
    this.spring.step(dt);
    this.write(this.spring.value);
    if (this.spring.settled()) this._finish(true);
  }
  _finish(completed) {
    active.delete(this); this.done = true;
    const map = registry.get(this.target);
    if (map?.get(this.prop) === this) map.delete(this.prop);
    for (const fn of this.listeners.splice(0)) fn(completed);
  }
}

/**
 * animate(elementOrObject, { prop: target, ... }, { damping, response, velocity, onUpdate, onComplete, immediate })
 * - Elements: x, y (px), scale, scaleX, scaleY, rotate (deg), opacity. Objects: any numeric property.
 * - velocity: number (all props) or { prop: unitsPerSecond }.
 * - Starts from the presented value; if the prop is already animating its spring is re-targeted, keeping velocity.
 * - Reduced motion: transform props jump, opacity cross-fades quickly.
 * Returns { finished: Promise<boolean>, stop(), springs, retarget(props, opts) }.
 */
export function animate(target, props, options = {}) {
  const el = isElement(target), state = el ? elementState(target) : target;
  const reduced = options.respectReducedMotion !== false && prefersReducedMotion();
  let map = registry.get(target);
  if (!map) { map = new Map(); registry.set(target, map); }
  const anims = [], springs = {};
  let pendingWrite = false;
  const flush = () => { pendingWrite = false; if (el) writeElement(target, state); options.onUpdate?.(state); };
  const write = prop => value => { state[prop] = value; if (!pendingWrite) { pendingWrite = true; queueMicrotask(flush); } };
  for (const [prop, to] of Object.entries(props)) {
    if (!Number.isFinite(to)) continue;
    if (!(prop in state)) state[prop] = DEFAULTS[prop] ?? 0;
    const instant = options.immediate || (reduced && (!el || TRANSFORM_PROPS.includes(prop)) && prop !== 'opacity' && !options.allowInReducedMotion);
    const params = reduced && prop === 'opacity' ? { damping: 1, response: 0.18 } : { damping: options.damping ?? 1, response: options.response ?? 0.35 };
    const velocity = typeof options.velocity === 'object' ? options.velocity?.[prop] : options.velocity;
    const existing = map.get(prop);
    if (instant) {
      if (existing) existing._finish(false);
      state[prop] = to; springs[prop] = new Spring(to, params); continue;
    }
    if (existing && !existing.done) {
      existing.spring.setTarget(to, { velocity, ...params });
      existing.write = write(prop); // the newest caller's onUpdate takes over
      springs[prop] = existing.spring; anims.push(existing); continue;
    }
    const spring = new Spring(Number(state[prop]), { ...params, restDelta: options.restDelta ?? restDeltaFor(prop), restSpeed: options.restSpeed ?? restDeltaFor(prop) * 10 });
    spring.setTarget(to, { velocity });
    const anim = new Animation(target, prop, spring, write(prop));
    map.set(prop, anim); anims.push(anim); springs[prop] = spring; schedule(anim);
  }
  flush();
  const finished = Promise.all(anims.map(a => a.done ? true : new Promise(resolve => a.listeners.push(resolve)))).then(r => r.every(Boolean));
  if (options.onComplete) finished.then(options.onComplete);
  return {
    finished, springs,
    stop() { for (const a of anims) if (!a.done) a._finish(false); },
    retarget(next, opts = {}) { return animate(target, next, { ...options, ...opts }); }
  };
}
const restDeltaFor = prop => (prop === 'opacity' || prop.startsWith('scale') ? 0.0005 : 0.05);

/** Current presented value of an element's motion state (useful to start a gesture from where the spring is). */
export function presented(el) { return { ...elementState(el) }; }
/** Stop every running spring on a target (keeps the presented value). */
export function stopAll(target) { const map = registry.get(target); if (map) for (const a of [...map.values()]) a._finish(false); }

/** Drive an arbitrary per-frame callback until it returns false (used by the canvas camera). */
export function frameLoop(fn) {
  const anim = { done: false, _step: dt => { if (fn(dt) === false) { active.delete(anim); anim.done = true; } } };
  schedule(anim);
  return { stop() { active.delete(anim); anim.done = true; }, get running() { return !anim.done; } };
}

// ---- snapping & scrubbing (pure; used by canvas drag, minimap, history scrubber, number fields) -------------------------
/**
 * Soft magnetic detent. Inside `radius` of `target` the presented value is pulled toward the target with a sticky core
 * (d·(|d|/r)^power): continuous at the boundary, monotone, and exactly the target at the centre — a detent you can feel
 * and still push through. Outside the radius the value is untouched (1:1 tracking).
 */
export function detent(raw, target, radius, power = 2) {
  const d = raw - target, a = Math.abs(d);
  if (!(radius > 0) || a >= radius) return raw;
  return target + d * Math.pow(a / radius, power);
}
/** Nearest multiple of `step` (offset by `origin`). */
export function nearestStep(value, step, origin = 0) { return step > 0 ? origin + Math.round((value - origin) / step) * step : value; }
/**
 * Magnetic snap of one axis. candidates: numbers; step: optional regular grid. Returns { value, target, engaged }:
 * value is the presented (detented) value, target the attracting snap (or null), engaged = visually locked on it.
 */
export function magneticSnap(raw, { candidates = [], step = 0, origin = 0, radius = 1, power = 2, lock = 0.12 } = {}) {
  let target = null, best = radius;
  const consider = c => { const d = Math.abs(raw - c); if (d < best) { best = d; target = c; } };
  for (const c of candidates) consider(c);
  if (step > 0) consider(nearestStep(raw, step, origin));
  if (target === null) return { value: raw, target: null, engaged: false };
  const value = detent(raw, target, radius, power);
  return { value, target, engaged: Math.abs(value - target) <= radius * lock };
}
/**
 * Where a released gesture should come to rest: project the momentum (Apple decay), then choose the snap point
 * nearest the *projected* position (grid steps around it + explicit candidates) if it lies within `reach`; otherwise
 * the projection itself (clamped). Returns { value, projected, snapped }.
 */
export function projectSnap(position, velocity, { step = 0, origin = 0, candidates = [], rate = 0.998, reach = Infinity, min = -Infinity, max = Infinity } = {}) {
  const projected = Math.min(max, Math.max(min, position + project(velocity, rate)));
  let best = null, bestD = reach;
  const consider = c => { if (c < min || c > max) return; const d = Math.abs(c - projected); if (d <= bestD) { bestD = d; best = c; } };
  for (const c of candidates) consider(c);
  if (step > 0) { const s = nearestStep(projected, step, origin); consider(s); consider(s - step); consider(s + step); }
  return best === null ? { value: projected, projected, snapped: false } : { value: best, projected, snapped: true };
}
/** Scrub rate from modifier keys: Shift = ×10 (coarse), Alt = ×0.1 (fine). */
export function scrubRate(base, { shift = false, alt = false } = {}) { return base * (shift ? 10 : 1) * (alt ? 0.1 : 1); }
/**
 * Value for a horizontal scrub of `dx` px from `start` at `perPx` units/px, rubber-banded past [min, max]
 * (resistance measured in px against `dimension`). Returns { value, raw, over } — over is the overshoot sign.
 */
export function scrubValue(start, dx, { perPx = 1, min = -Infinity, max = Infinity, dimension = 160, constant = 0.55 } = {}) {
  const raw = start + dx * perPx;
  if (raw > max) return { value: max + rubberband((raw - max) / perPx, dimension, constant) * perPx, raw, over: 1 };
  if (raw < min) return { value: min + rubberband((raw - min) / perPx, dimension, constant) * perPx, raw, over: -1 };
  return { value: raw, raw, over: 0 };
}
