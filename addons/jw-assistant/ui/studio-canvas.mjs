// Studio canvas. Two layers: a cached "base" (drawing batched by layer × pen × tile as Path2D, culled by tile) and an
// "overlay" (hover, selection halo, marquee, diff). Coordinates are paper mm (what prints), Y up. The camera is three
// springs (centre x/y, log zoom) so fits and wheel zooms are interruptible; drags track 1:1, release hands velocity to
// momentum (Apple projection, d≈0.998) and rubber-bands at the limits.
import { Spring, VelocityTracker, rubberband, frameLoop, prefersReducedMotion } from './motion.mjs';
import { moveSnap, releaseTarget } from './studio/dragmove.mjs';

// ---- legacy helpers (IR v2 display; kept for tests and the v1 flow) --------------------------------------------------
const point = (m, x, y) => [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];
export function displayPrimitives(ir) {
  return (ir?.expandedEntities ?? []).flatMap(e => {
    const g = e.geometry, m = e.transformToModel;
    if (!g || !m?.every(Number.isFinite)) return [];
    let vertices = [];
    if (g.kind === 'line' && e.modelPoints?.every(Number.isFinite)) vertices = [e.modelPoints.slice(0, 2), e.modelPoints.slice(2)];
    if (g.kind === 'text' && e.modelAnchor?.every(Number.isFinite)) vertices = [e.modelAnchor];
    if (g.kind === 'point' && e.modelPoint?.every(Number.isFinite)) vertices = [e.modelPoint];
    if (g.kind === 'ellipse-arc' && [...g.center, g.radius, g.ratio, g.tiltRadians, g.startRadians, g.sweepRadians].every(Number.isFinite) && g.radius > 0 && g.ratio > 0) {
      const start = g.full ? 0 : g.startRadians, sweep = g.full ? Math.PI * 2 : g.sweepRadians;
      for (let i = 0; i <= 64; i++) {
        const angle = start + sweep*i/64, x = g.radius*Math.cos(angle), y = g.radius*g.ratio*Math.sin(angle), c = Math.cos(g.tiltRadians), s = Math.sin(g.tiltRadians);
        vertices.push(point(m, g.center[0] + c*x - s*y, g.center[1] + s*x + c*y));
      }
    }
    if (!vertices.length || !vertices.flat().every(Number.isFinite)) return [];
    const xs = vertices.map(p => p[0]), ys = vertices.map(p => p[1]);
    return [{ ...e, rootId: e.path.split('/')[0], vertices, bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }];
  });
}
export function nearestPrimitive(items, x, y, tolerance) {
  let id = null, best = tolerance;
  for (const item of items) {
    for (let i = 0; i < Math.max(1, item.vertices.length - 1); i++) {
      const [ax, ay] = item.vertices[i], [bx, by] = item.vertices[i+1] ?? item.vertices[i];
      const dx = bx-ax, dy = by-ay, t = Math.max(0, Math.min(1, ((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy || 1)));
      const distance = Math.hypot(x-ax-t*dx, y-ay-t*dy);
      if (distance < best) { best = distance; id = item.rootId; }
    }
  }
  return id;
}

// ---- pens --------------------------------------------------------------------------------------------------------------
// Jw_cad line types in paper mm (approximate print patterns). 9 = auxiliary (not printed): drawn faint.
const DASH = { 2: [1.2, 0.8], 3: [0.5, 0.6], 4: [4, 0.8, 0.6, 0.8], 5: [8, 1, 1, 1], 6: [4, 0.8, 0.6, 0.8, 0.6, 0.8], 7: [8, 1, 1, 1, 1, 1], 8: [2.5, 1.2], 9: [0.6, 0.6] };
const DEFAULT_RGB = { 1: [0, 160, 170], 2: [0, 0, 0], 3: [0, 150, 0], 4: [150, 130, 0], 5: [192, 0, 192], 6: [0, 0, 255], 7: [110, 110, 110], 8: [220, 60, 60], 9: [150, 150, 150] };
const DEFAULT_WIDTH = { 1: 10, 2: 13, 3: 8, 4: 8, 5: 10, 6: 15, 7: 8, 8: 8, 9: 6 };
function adjustForDark([r, g, b]) {
  // keep hue, lift dark pens so they read on a dark sheet (black ink → near-white)
  const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (l < 0.18) return [232, 232, 236];
  if (l < 0.45) { const k = 0.45 / Math.max(l, 0.05); return [r, g, b].map(v => Math.min(255, Math.round(v * k + 40))); }
  return [r, g, b];
}
export function penPalette(pens, dark) {
  const rgb = {}, width = {};
  for (let c = 0; c <= 9; c++) {
    const src = pens?.screenRgb?.[c] ?? DEFAULT_RGB[c] ?? DEFAULT_RGB[2];
    const v = dark ? adjustForDark(src) : src;
    rgb[c] = `rgb(${v[0]},${v[1]},${v[2]})`;
    width[c] = (pens?.printWidth?.[c] ?? DEFAULT_WIDTH[c] ?? 12) / 100; // paper mm
  }
  return { rgb, width, fg: dark ? 'rgb(232,232,236)' : 'rgb(20,20,22)' };
}
const solidColor = (rgb) => `rgb(${rgb & 255},${(rgb >> 8) & 255},${(rgb >> 16) & 255})`;

// ---- geometry helpers ----------------------------------------------------------------------------------------------
function primBounds(p) {
  if (p.t === 4) { const len = [...(p.tx ?? '')].length || 1, w = (p.wd || p.h) * len, h = p.h || 1, a = (p.a || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const x = p.p[0], y = p.p[1], xs = [x, x + w * c, x - h * s, x + w * c - h * s], ys = [y, y + w * s, y + h * c, y + w * s + h * c];
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (let i = 0; i < p.p.length; i += 2) { const x = p.p[i], y = p.p[i + 1]; if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; }
  return [x1, y1, x2, y2];
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function segRect(ax, ay, bx, by, r) {
  // Liang–Barsky style test: does segment ab touch rect r=[x1,y1,x2,y2]?
  let t0 = 0, t1 = 1; const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [[-dx, ax - r[0]], [dx, r[2] - ax], [-dy, ay - r[1]], [dy, r[3] - ay]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}
const inside = (b, r) => b[0] >= r[0] && b[2] <= r[2] && b[1] >= r[1] && b[3] <= r[3];
const touches = (b, r) => b[0] <= r[2] && b[2] >= r[0] && b[1] <= r[3] && b[3] >= r[1];
const union = (a, b) => (a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : [...b]);

function tracePrim(path, p, dx = 0, dy = 0) {
  const q = p.p;
  if (p.t === 2) { const r = 0.25; path.moveTo(q[0] + dx + r, q[1] + dy); path.arc(q[0] + dx, q[1] + dy, r, 0, Math.PI * 2); return; }
  path.moveTo(q[0] + dx, q[1] + dy);
  for (let i = 2; i < q.length; i += 2) path.lineTo(q[i] + dx, q[i + 1] + dy);
  if (p.t === 3) path.closePath();
}

/** Batch a scene's primitives by pen × line type × tile (Path2D) for fast culled drawing. skip: Sets of entity indices. */
export function batchScene(s, { hidden = new Set(), skip = [], bbox = s?.bbox } = {}) {
  const out = { batches: [], texts: [], solids: [] };
  if (!s) return out;
  const skips = skip.filter(x => x?.size), b = bbox ?? [0, 0, 1, 1], T = 12;
  const tw = Math.max((b[2] - b[0]) / T, 1e-6), th = Math.max((b[3] - b[1]) / T, 1e-6), map = new Map();
  for (const p of s.prims) {
    if (hidden.has(p.l) || (skips.length && skips.some(x => x.has(p.e)))) continue;
    p._b ??= primBounds(p);
    if (p.t === 4) { out.texts.push(p); continue; }
    if (p.t === 3) { out.solids.push(p); continue; }
    const cx = Math.min(T - 1, Math.max(0, Math.floor(((p._b[0] + p._b[2]) / 2 - b[0]) / tw))), cy = Math.min(T - 1, Math.max(0, Math.floor(((p._b[1] + p._b[3]) / 2 - b[1]) / th)));
    const style = p.s >= 2 && p.s <= 9 ? p.s : 1, key = `${p.c}|${style}|${p.t === 2 ? 'p' : 'l'}|${cx},${cy}`;
    let batch = map.get(key);
    if (!batch) { batch = { color: p.c, style, point: p.t === 2, path: new Path2D(), bbox: null, count: 0 }; map.set(key, batch); }
    tracePrim(batch.path, p); batch.bbox = union(batch.bbox, p._b); batch.count++;
  }
  out.batches = [...map.values()].sort((a, b2) => a.style - b2.style || a.color - b2.color);
  return out;
}

export class DrawingView {
  /**
   * opts: base, overlay (canvases), host (element sized like the viewport), insets() -> {l,t,r,b} px of chrome over
   * the canvas, onHover(index|-1), onSelect(indices[], mode 'replace'|'add'|'toggle'), onCamera({z, cx, cy}),
   * onPointer({x, y}|null) model-free paper coordinates of the cursor.
   */
  constructor(opts) {
    Object.assign(this, { onHover() {}, onSelect() {}, onCamera() {}, onPointer() {}, onMoveDrag() {}, onMoveCommit() {}, onContext() {}, canMove: () => true,
      insets: () => ({ l: 0, t: 0, r: 0, b: 0 }) }, opts);
    // direct manipulation (drag the selection): presented offset springs (paper mm) + snap "detent" pulse
    this.move = null; this.excluded = null; this.moveSpring = { x: new Spring(0, { restDelta: 1e-4 }), y: new Spring(0, { restDelta: 1e-4 }) };
    this.snapPulse = new Spring(1, { damping: 0.6, response: 0.22, restDelta: 0.002 }); this.focus = false;
    this.bctx = this.base.getContext('2d'); this.octx = this.overlay.getContext('2d');
    this.scene = null; this.hidden = new Set(); this.selection = new Set(); this.hover = -1; this.diff = null; this.tool = 'select';
    this.cam = { cx: 0, cy: 0, z: 1 }; this.springs = null; this.camLoop = null; this.anchor = null; this.momentum = null;
    this.halo = new Spring(1, { damping: 1, response: 0.32, restDelta: 0.002 }); this.diffT = new Spring(1, { damping: 1, response: 0.55, restDelta: 0.001 });
    this.overlayLoop = null; this.dirty = { base: true, overlay: true }; this.frame = 0; this.space = false; this.pointers = new Map();
    this.palette = penPalette(null, false);
    this.resize = new ResizeObserver(() => this.layout()); this.resize.observe(this.host);
    this.bind();
    this.layout();
  }

  // ---- data ---------------------------------------------------------------------------------------------------------
  setPens(pens, dark) { this.pens = pens; this.dark = dark; this.palette = penPalette(pens, dark); this.invalidate(); }
  setScene(scene, { keepCamera = false } = {}) {
    this.scene = scene; this.diff = null; this.hover = -1; this.move = null; this.excluded = null;
    const n = scene?.ents.length ?? 0;
    this.entPrims = Array.from({ length: n }, () => []);
    scene?.prims.forEach((p, i) => { this.entPrims[p.e]?.push(i); p._b ??= primBounds(p); });
    this.bbox = scene?.bbox ?? null;
    this.buildIndex(); this.buildBatches();
    if (!keepCamera) this.fit(this.bbox, { animate: false });
    this.invalidate();
  }
  setHiddenLayers(set) { this.hidden = new Set(set); this.buildBatches(); this.invalidate(); }
  setSelection(indices, { animate = true } = {}) {
    const next = new Set(indices), changed = next.size !== this.selection.size || [...next].some(i => !this.selection.has(i));
    this.selection = next;
    if (changed && next.size && animate && !prefersReducedMotion()) { this.halo.jump(0); this.halo.setTarget(1); this.animateOverlay(); }
    else this.halo.jump(1);
    this.dirty.overlay = true; this.request();
  }
  setDiff(diff) {
    this.diff = diff ? { ...diff, removedSet: new Set(diff.removed), movedTo: new Map(diff.moves.map(m => [m.to, m])) } : null;
    if (this.diff) for (const p of this.diff.added.prims) p._b ??= primBounds(p);
    this.buildBatches();
    this.replayDiff();
    this.invalidate();
  }
  replayDiff() {
    if (!this.diff) return;
    if (prefersReducedMotion()) this.diffT.jump(1); else { this.diffT.jump(0); this.diffT.setTarget(1); this.animateOverlay(); }
    this.dirty.overlay = true; this.request();
  }
  setTool(tool) { this.tool = tool; this.updateCursor(); }
  invalidate() { this.dirty.base = this.dirty.overlay = true; this.request(); }

  buildBatches() {
    const set = batchScene(this.scene, { hidden: this.hidden, skip: [this.diff?.removedSet, this.excluded], bbox: this.bbox });
    this.batches = set.batches; this.texts = set.texts; this.solids = set.solids;
  }
  buildIndex() {
    const s = this.scene; this.grid = null;
    if (!s?.prims.length || !this.bbox) return;
    const b = this.bbox, N = 160, cw = Math.max((b[2] - b[0]) / N, 1e-6), ch = Math.max((b[3] - b[1]) / N, 1e-6), cells = new Map();
    s.prims.forEach((p, i) => {
      const x1 = Math.max(0, Math.floor((p._b[0] - b[0]) / cw)), x2 = Math.min(N - 1, Math.floor((p._b[2] - b[0]) / cw));
      const y1 = Math.max(0, Math.floor((p._b[1] - b[1]) / ch)), y2 = Math.min(N - 1, Math.floor((p._b[3] - b[1]) / ch));
      if ((x2 - x1 + 1) * (y2 - y1 + 1) > 400) { (cells.get('big') ?? cells.set('big', []).get('big')).push(i); return; }
      for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) { const k = x * N + y; (cells.get(k) ?? cells.set(k, []).get(k)).push(i); }
    });
    this.grid = { b, N, cw, ch, cells };
  }
  /** Nearest entity index within `tol` paper mm of (x, y), or -1. Text and solids hit by their area. */
  hitTest(x, y, tol) {
    const g = this.grid, s = this.scene; if (!g) return -1;
    const x1 = Math.max(0, Math.floor((x - tol - g.b[0]) / g.cw)), x2 = Math.min(g.N - 1, Math.floor((x + tol - g.b[0]) / g.cw));
    const y1 = Math.max(0, Math.floor((y - tol - g.b[1]) / g.ch)), y2 = Math.min(g.N - 1, Math.floor((y + tol - g.b[1]) / g.ch));
    const seen = new Set(), cand = [...(g.cells.get('big') ?? [])];
    for (let cx = x1; cx <= x2; cx++) for (let cy = y1; cy <= y2; cy++) for (const i of g.cells.get(cx * g.N + cy) ?? []) cand.push(i);
    let best = -1, bestD = tol;
    for (const i of cand) {
      if (seen.has(i)) continue; seen.add(i);
      const p = s.prims[i];
      if (this.hidden.has(p.l) || this.diff?.removedSet.has(p.e)) continue;
      let d;
      if (p.t === 4 || p.t === 3) d = (x >= p._b[0] && x <= p._b[2] && y >= p._b[1] && y <= p._b[3]) ? tol * 0.5 : Infinity;
      else if (p.p.length === 2) d = Math.hypot(x - p.p[0], y - p.p[1]);
      else { d = Infinity; for (let k = 0; k + 3 < p.p.length; k += 2) d = Math.min(d, segDist(x, y, p.p[k], p.p[k + 1], p.p[k + 2], p.p[k + 3])); }
      if (d < bestD) { bestD = d; best = p.e; }
    }
    return best;
  }
  /** Entities in a paper-mm rect; window = fully inside, crossing = touching. */
  query(rect, crossing) {
    const s = this.scene, out = [];
    if (!s) return out;
    s.ents.forEach((e, i) => {
      if (!e.b || this.hidden.has(e.l) || this.diff?.removedSet.has(i)) return;
      if (!crossing) { if (inside(e.b, rect)) out.push(i); return; }
      if (!touches(e.b, rect)) return;
      if (inside(e.b, rect)) { out.push(i); return; }
      for (const pi of this.entPrims[i]) {
        const p = s.prims[pi];
        if (p.t === 4 || p.t === 3 || p.p.length === 2) { if (touches(p._b, rect)) { out.push(i); return; } continue; }
        for (let k = 0; k + 3 < p.p.length; k += 2) if (segRect(p.p[k], p.p[k + 1], p.p[k + 2], p.p[k + 3], rect)) { out.push(i); return; }
      }
    });
    return out;
  }
  boundsOf(indices) { let b = null; for (const i of indices) { const e = this.scene?.ents[i]; if (e?.b) b = union(b, e.b); } return b; }

  // ---- camera -----------------------------------------------------------------------------------------------------------
  layout() {
    const r = this.host.getBoundingClientRect(), dpr = globalThis.devicePixelRatio || 1;
    this.W = r.width; this.H = r.height; this.dpr = dpr;
    for (const c of [this.base, this.overlay]) { c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr)); }
    this.invalidate();
  }
  safeRect() { const i = this.insets(); return { x: i.l, y: i.t, w: Math.max(80, this.W - i.l - i.r), h: Math.max(80, this.H - i.t - i.b) }; }
  zoomLimits() {
    const b = this.bbox ?? [0, 0, 420, 297], r = this.safeRect(), fitZ = Math.min(r.w / Math.max(b[2] - b[0], 1), r.h / Math.max(b[3] - b[1], 1));
    return { min: Math.min(fitZ * 0.2, 0.05), max: 600 };
  }
  centerLimits() {
    const b = this.bbox ?? [0, 0, 420, 297], mx = this.W / this.cam.z * 0.45, my = this.H / this.cam.z * 0.45;
    return { x1: b[0] - mx, x2: b[2] + mx, y1: b[1] - my, y2: b[3] + my };
  }
  toScreen(x, y) { return [this.W / 2 + (x - this.cam.cx) * this.cam.z, this.H / 2 - (y - this.cam.cy) * this.cam.z]; }
  toPaper(sx, sy) { return [this.cam.cx + (sx - this.W / 2) / this.cam.z, this.cam.cy - (sy - this.H / 2) / this.cam.z]; }
  /** Camera that frames bbox inside the safe area (between the floating panels). */
  cameraFor(b, padding = 32) {
    const r = this.safeRect(), w = Math.max(b[2] - b[0], 1e-3), h = Math.max(b[3] - b[1], 1e-3);
    const lim = this.zoomLimits(), z = Math.min(lim.max, Math.max(lim.min, Math.min((r.w - padding * 2) / w, (r.h - padding * 2) / h)));
    const scx = r.x + r.w / 2, scy = r.y + r.h / 2; // safe-area centre in screen px
    return { cx: (b[0] + b[2]) / 2 - (scx - this.W / 2) / z, cy: (b[1] + b[3]) / 2 + (scy - this.H / 2) / z, z };
  }
  fit(b, { animate = true, padding } = {}) {
    if (!b) return;
    const target = this.cameraFor(b, padding);
    if (!animate || prefersReducedMotion() || !this.W) { this.stopCamera(); Object.assign(this.cam, target); this.cameraChanged(); return; }
    this.springTo(target, { damping: 1, response: 0.5 });
  }
  fitAll(opts) { this.fit(this.bbox, opts); }
  fitSelection(opts) { this.fit(this.boundsOf(this.selection) ?? this.bbox, { padding: 64, ...opts }); }
  springTo(target, params, velocity = {}) {
    this.stopMomentum(); this.anchor = null;
    const s = this.springs ??= { cx: new Spring(this.cam.cx), cy: new Spring(this.cam.cy), lz: new Spring(Math.log(this.cam.z)) };
    if (!this.camLoop?.running) { s.cx.jump(this.cam.cx); s.cy.jump(this.cam.cy); s.lz.jump(Math.log(this.cam.z)); }
    for (const k of ['cx', 'cy', 'lz']) {
      s[k].restDelta = k === 'lz' ? 1e-4 : 1e-3 / this.cam.z; s[k].restSpeed = s[k].restDelta * 10;
    }
    s.cx.setTarget(target.cx, { ...params, velocity: velocity.cx }); s.cy.setTarget(target.cy, { ...params, velocity: velocity.cy });
    s.lz.setTarget(Math.log(target.z), { ...params, velocity: velocity.lz });
    this.runCamera();
  }
  runCamera() {
    if (this.camLoop?.running) return;
    this.camLoop = frameLoop(dt => {
      const s = this.springs; if (!s) return false;
      s.lz.step(dt); this.cam.z = Math.exp(s.lz.value);
      if (this.anchor) { // keep the model point under the cursor while the zoom spring runs
        const a = this.anchor; this.cam.cx = a.px - (a.sx - this.W / 2) / this.cam.z; this.cam.cy = a.py + (a.sy - this.H / 2) / this.cam.z;
        s.cx.jump(this.cam.cx); s.cy.jump(this.cam.cy);
      } else { s.cx.step(dt); s.cy.step(dt); this.cam.cx = s.cx.value; this.cam.cy = s.cy.value; }
      this.cameraChanged();
      const done = s.lz.settled() && (this.anchor || (s.cx.settled() && s.cy.settled()));
      if (done) { this.anchor = null; this.settleLimits(); }
      return !done;
    });
  }
  stopCamera() { this.camLoop?.stop(); this.camLoop = null; this.anchor = null; }
  stopMomentum() { this.momentum?.stop(); this.momentum = null; }
  cameraChanged() { this.dirty.base = this.dirty.overlay = true; this.request(); this.onCamera({ ...this.cam }); }
  /** Zoom by factor about screen point (sx, sy). animate=true uses the log-zoom spring (mouse wheel notches). */
  zoomAt(factor, sx = this.W / 2, sy = this.H / 2, { animate = false } = {}) {
    if (!this.scene) return;
    const lim = this.zoomLimits();
    if (animate && !prefersReducedMotion()) {
      const s = this.springs ??= { cx: new Spring(this.cam.cx), cy: new Spring(this.cam.cy), lz: new Spring(Math.log(this.cam.z)) };
      if (!this.camLoop?.running) { s.lz.jump(Math.log(this.cam.z)); }
      this.stopMomentum();
      const [px, py] = this.toPaper(sx, sy);
      this.anchor = { sx, sy, px, py };
      const target = Math.min(Math.log(lim.max), Math.max(Math.log(lim.min), s.lz.target + Math.log(factor)));
      s.lz.restDelta = 1e-4; s.lz.restSpeed = 1e-3;
      s.lz.setTarget(target, { damping: 1, response: 0.28 });
      this.runCamera();
      return;
    }
    this.stopCamera(); this.stopMomentum();
    const [px, py] = this.toPaper(sx, sy), lmin = Math.log(lim.min), lmax = Math.log(lim.max);
    let lz = Math.log(this.cam.z) + Math.log(factor);
    // rubber-band past the zoom limits (pinch); settleLimits() springs back
    if (lz < lmin) lz = lmin + rubberband(lz - lmin, 1, 0.3); else if (lz > lmax) lz = lmax + rubberband(lz - lmax, 1, 0.3);
    this.cam.z = Math.exp(lz);
    this.cam.cx = px - (sx - this.W / 2) / this.cam.z; this.cam.cy = py + (sy - this.H / 2) / this.cam.z;
    this.cameraChanged();
    clearTimeout(this.settleTimer); this.settleTimer = setTimeout(() => this.settleLimits(), 160);
  }
  /** Put paper point (cx, cy) at the screen centre immediately (minimap drag: 1:1). */
  centerOn(cx, cy) { this.stopCamera(); this.stopMomentum(); this.cam.cx = cx; this.cam.cy = cy; this.cameraChanged(); }
  panBy(dxPx, dyPx, { rubber = true } = {}) {
    this.stopCamera();
    const raw = { cx: this.cam.cx - dxPx / this.cam.z, cy: this.cam.cy + dyPx / this.cam.z };
    const l = this.centerLimits(), dimX = this.W / this.cam.z, dimY = this.H / this.cam.z;
    const band = (v, lo, hi, dim) => {
      if (!rubber) return v;
      // apply resistance only to the motion that pushes further out
      if (v < lo) return lo + rubberband(v - lo, dim);
      if (v > hi) return hi + rubberband(v - hi, dim);
      return v;
    };
    this.rawCam = raw; this.cam.cx = band(raw.cx, l.x1, l.x2, dimX); this.cam.cy = band(raw.cy, l.y1, l.y2, dimY);
    this.cameraChanged();
  }
  /** After a gesture: spring back inside zoom/centre limits, carrying the given velocity (paper mm/s). */
  settleLimits(velocity = {}) {
    if (!this.scene) return;
    const lim = this.zoomLimits(), z = Math.min(lim.max, Math.max(lim.min, this.cam.z));
    const zCam = { ...this.cam, z }, saved = this.cam; this.cam = zCam; const l = this.centerLimits(); this.cam = saved;
    const cx = Math.min(l.x2, Math.max(l.x1, this.cam.cx)), cy = Math.min(l.y2, Math.max(l.y1, this.cam.cy));
    if (cx === this.cam.cx && cy === this.cam.cy && z === this.cam.z) return;
    this.springTo({ cx, cy, z }, { damping: 1, response: 0.45 }, velocity);
  }
  /** Release of a pan: exponential-decay momentum (Apple projection), bounce at the limits. v in screen px/s. */
  fling(vx, vy) {
    const speed = Math.hypot(vx, vy);
    if (speed < 40 || prefersReducedMotion()) { this.settleLimits(); return; }
    const d = 0.998; let vcx = -vx / this.cam.z, vcy = vy / this.cam.z;
    this.stopMomentum();
    this.momentum = frameLoop(dt => {
      const k = Math.pow(d, dt * 1000);
      this.cam.cx += vcx * dt; this.cam.cy += vcy * dt; vcx *= k; vcy *= k;
      const l = this.centerLimits();
      if (this.cam.cx < l.x1 || this.cam.cx > l.x2 || this.cam.cy < l.y1 || this.cam.cy > l.y2) {
        this.momentum = null; this.settleLimits({ cx: vcx, cy: vcy }); this.cameraChanged(); return false;
      }
      this.cameraChanged();
      return Math.hypot(vcx, vcy) * this.cam.z > 8;
    });
  }

  // ---- input ----------------------------------------------------------------------------------------------------------
  bind() {
    const el = this.overlay;
    el.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    el.addEventListener('pointerdown', e => this.onDown(e));
    el.addEventListener('pointermove', e => this.onMove(e));
    el.addEventListener('pointerup', e => this.onUp(e));
    el.addEventListener('pointercancel', e => this.onUp(e, true));
    el.addEventListener('pointerleave', () => { if (!this.drag) { this.setHover(-1); this.onPointer(null); } });
    el.addEventListener('dblclick', e => this.onDouble(e));
    el.addEventListener('contextmenu', e => e.preventDefault());
  }
  local(e) { const r = this.overlay.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  onWheel(e) {
    e.preventDefault(); if (!this.scene) return;
    const [sx, sy] = this.local(e), unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.H : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.ctrlKey || e.metaKey) { this.zoomAt(Math.exp(-dy * 0.01), sx, sy); return; } // trackpad pinch / ctrl+wheel
    const mouseWheel = e.deltaMode !== 0 || (dx === 0 && Math.abs(dy) >= 48 && Number.isInteger(e.deltaY));
    if (mouseWheel) { this.zoomAt(Math.pow(1.25, -Math.sign(dy) * Math.min(3, Math.abs(dy) / 100 || 1)), sx, sy, { animate: true }); return; }
    if (e.shiftKey && !dx) this.panBy(-dy, 0); else this.panBy(-dx, -dy);
    clearTimeout(this.settleTimer); this.settleTimer = setTimeout(() => this.settleLimits(), 140);
  }
  onDown(e) {
    if (!this.scene) return;
    this.overlay.focus({ preventScroll: true });
    // grabbing a moving canvas stops it on the spot (interruptible)
    this.stopMomentum(); if (this.camLoop?.running) { this.stopCamera(); }
    const [x, y] = this.local(e);
    this.pointers.set(e.pointerId, { x, y });
    this.overlay.setPointerCapture(e.pointerId);
    if (this.pointers.size === 2) { // pinch begins: cancel any one-finger gesture
      const [a, b] = [...this.pointers.values()];
      this.drag = { mode: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
      this.dirty.overlay = true; this.request(); return;
    }
    if (this.pointers.size > 2) return;
    const pan = e.button === 1 || e.button === 2 || this.space || this.tool === 'pan' || e.pointerType === 'touch';
    this.drag = { mode: pan ? 'pan' : 'press', button: e.button, x0: x, y0: y, x, y, last: [x, y], shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey, moved: false, vt: new VelocityTracker() };
    if (this.move && this.move.phase !== 'drag') this.clearMove(); // a new gesture supersedes a settled/committed drag preview
    if (!pan && e.button === 0 && !e.shiftKey && !this.drag.toggle && this.selection.size && this.canMove()) {
      // pressing on an already-selected entity grabs the selection (1:1 move); elsewhere it stays a click/marquee
      const [px, py] = this.toPaper(x, y), hit = this.hitTest(px, py, 6 / this.cam.z);
      if (hit >= 0 && this.selection.has(hit)) { const g = this.grabInfo(px, py); if (g) Object.assign(this.drag, { mode: 'grab', grab: [px, py], ...g }); }
    }
    this.drag.vt.add(x, y, e.timeStamp);
    this.updateCursor();
  }
  onMove(e) {
    const [x, y] = this.local(e);
    if (this.scene) this.onPointer(this.toPaper(x, y));
    const d = this.drag;
    if (!d) { this.queueHover(x, y); return; }
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x, y });
    if (d.mode === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()], dist = Math.hypot(a.x - b.x, a.y - b.y), mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      this.panBy(mid[0] - d.mid[0], mid[1] - d.mid[1], { rubber: false });
      this.zoomAt(dist / Math.max(d.dist, 1), mid[0], mid[1]);
      d.dist = dist; d.mid = mid; return;
    }
    d.vt.add(x, y, e.timeStamp);
    if (!d.moved && Math.hypot(x - d.x0, y - d.y0) > 4) {
      d.moved = true; this.setHover(-1);
      if (d.mode === 'press') d.mode = 'marquee';
      if (d.mode === 'grab') { d.mode = 'move'; this.startMove(d); }
    }
    if (d.mode === 'move') this.dragMove(x, y, e);
    if (d.mode === 'pan' && d.moved) { this.panBy(x - d.last[0], y - d.last[1]); }
    d.last = [x, y]; d.x = x; d.y = y;
    if (d.mode === 'marquee') { this.dirty.overlay = true; this.request(); }
  }
  onUp(e, cancelled = false) {
    const d = this.drag; this.pointers.delete(e.pointerId);
    if (!d) return;
    if (d.mode === 'pinch') { if (this.pointers.size === 0) { this.drag = null; this.settleLimits(); } return; }
    this.drag = null; this.updateCursor();
    if (d.mode === 'move') { if (cancelled) this.cancelMove(); else this.releaseMove(d, e); return; }
    if (cancelled) { this.dirty.overlay = true; this.request(); this.settleLimits(); return; }
    const [x, y] = this.local(e);
    if (d.mode === 'pan' && !d.moved && d.button === 2) { // right-click (no drag) → context menu at the pointer
      const [px, py] = this.toPaper(x, y), hit = this.hitTest(px, py, 6 / this.cam.z);
      if (hit >= 0 && !this.selection.has(hit)) this.onSelect([hit], 'replace');
      this.onContext(e.clientX, e.clientY, hit); return;
    }
    if (d.mode === 'pan') { if (d.moved) { const v = d.vt.velocity(e.timeStamp); this.fling(v.x, v.y); } else this.click(x, y, d); return; }
    if (d.mode === 'marquee') {
      const a = this.toPaper(d.x0, d.y0), b = this.toPaper(x, y), rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      const crossing = x < d.x0, hits = this.query(rect, crossing);
      this.onSelect(hits, d.shift || d.toggle ? 'add' : 'replace');
      this.dirty.overlay = true; this.request(); return;
    }
    this.click(x, y, d);
  }
  click(x, y, d) {
    const [px, py] = this.toPaper(x, y), hit = this.hitTest(px, py, 6 / this.cam.z);
    if (hit < 0) { if (!d.shift && !d.toggle) this.onSelect([], 'replace'); return; }
    this.onSelect([hit], d.shift || d.toggle ? 'toggle' : 'replace');
  }
  // ---- direct manipulation: drag the selection ----------------------------------------------------------------------
  /** One layer scale for the whole selection (Patch translate is model mm per entity) + the grabbed vertex, or null. */
  grabInfo(px, py) {
    const s = this.scene, scales = new Set([...this.selection].map(i => s.layers[s.ents[i].l]?.scale || 1));
    if (scales.size !== 1) return null;
    let ref = null, best = 12 / this.cam.z;
    for (const i of this.selection) for (const pi of this.entPrims[i] ?? []) {
      const p = s.prims[pi]; if (p.t === 3 || p.t === 4) continue;
      const q = p.p, ends = q.length === 2 ? [[q[0], q[1]]] : [[q[0], q[1]], [q[q.length - 2], q[q.length - 1]]];
      for (const v of ends) { const dd = Math.hypot(v[0] - px, v[1] - py); if (dd < best) { best = dd; ref = v; } }
    }
    return { scale: [...scales][0], ref };
  }
  /** Endpoints of visible, unselected entities within r paper mm of (x, y) (spatial grid lookup). */
  endpointsNear(x, y, r) {
    const g = this.grid, s = this.scene, out = []; if (!g) return out;
    const x1 = Math.max(0, Math.floor((x - r - g.b[0]) / g.cw)), x2 = Math.min(g.N - 1, Math.floor((x + r - g.b[0]) / g.cw));
    const y1 = Math.max(0, Math.floor((y - r - g.b[1]) / g.ch)), y2 = Math.min(g.N - 1, Math.floor((y + r - g.b[1]) / g.ch));
    const seen = new Set();
    for (let cx = x1; cx <= x2; cx++) for (let cy = y1; cy <= y2; cy++) for (const i of g.cells.get(cx * g.N + cy) ?? []) {
      if (seen.has(i)) continue; seen.add(i);
      const p = s.prims[i]; if (p.t === 3 || p.t === 4 || this.hidden.has(p.l) || this.selection.has(p.e) || this.diff?.removedSet.has(p.e)) continue;
      const q = p.p;
      for (const v of q.length === 2 ? [[q[0], q[1]]] : [[q[0], q[1]], [q[q.length - 2], q[q.length - 1]]]) if (Math.abs(v[0] - x) <= r && Math.abs(v[1] - y) <= r) out.push(v);
      if (out.length > 400) return out;
    }
    return out;
  }
  startMove(d) {
    this.move = { phase: 'drag', grab: d.grab, scale: d.scale, ref: d.ref, ids: [...this.selection], result: null, engaged: false };
    this.moveSpring.x.jump(0); this.moveSpring.y.jump(0);
    this.excluded = new Set(this.selection); this.buildBatches(); this.invalidate(); this.updateCursor();
  }
  dragMove(x, y, e) {
    const m = this.move; if (!m) return;
    const [px, py] = this.toPaper(x, y), raw = [px - m.grab[0], py - m.grab[1]], R = 10 / this.cam.z;
    // endpoints right next to where the grabbed vertex started (the other face of a double wall line, a joint) would
    // yank the first pixels of the drag sideways: they only become snap targets once the drag has left them behind
    const endpoints = m.ref ? this.endpointsNear(m.ref[0] + raw[0], m.ref[1] + raw[1], R).filter(v => Math.hypot(v[0] - m.ref[0], v[1] - m.ref[1]) > R * 1.5 || Math.hypot(raw[0], raw[1]) > R * 3) : [];
    const r = moveSnap({ raw, ref: m.ref, endpoints, scale: m.scale, zoom: this.cam.z, free: e.altKey });
    const engagedTarget = r.engaged ? JSON.stringify(r.snap?.target?.map(v => v.toFixed(5))) : null;
    if (engagedTarget && engagedTarget !== m.engaged && !prefersReducedMotion()) { this.snapPulse.jump(1.8); this.snapPulse.setTarget(1); this.animateOverlay(); } // the detent "click"
    m.engaged = engagedTarget ?? false; m.result = r;
    this.moveSpring.x.jump(r.d[0]); this.moveSpring.y.jump(r.d[1]); // 1:1 while the finger is down
    this.onMoveDrag({ clientX: e.clientX, clientY: e.clientY, model: r.model, snap: r.snap, engaged: r.engaged, free: e.altKey });
    this.dirty.overlay = true; this.request();
  }
  releaseMove(d, e) {
    const m = this.move; if (!m?.result) { this.cancelMove(); return; }
    const target = releaseTarget(m.result, m.scale), model = target.map(v => Math.round(v * m.scale * 10) / 10);
    if (!model[0] && !model[1]) { this.cancelMove(); return; }
    m.phase = 'settle'; m.target = target; m.model = model;
    const v = d.vt.velocity(e.timeStamp), vel = { x: v.x / this.cam.z, y: -v.y / this.cam.z }; // velocity handoff (paper mm/s)
    if (prefersReducedMotion()) { this.moveSpring.x.jump(target[0]); this.moveSpring.y.jump(target[1]); }
    else { this.moveSpring.x.setTarget(target[0], { velocity: vel.x, damping: 0.86, response: 0.28 }); this.moveSpring.y.setTarget(target[1], { velocity: vel.y, damping: 0.86, response: 0.28 }); }
    this.animateOverlay();
  }
  /** Esc during a drag: the selection springs back home. */
  abortMove() { if (this.drag?.mode !== 'move') return; this.drag = null; this.cancelMove(); this.updateCursor(); }
  cancelMove() {
    const m = this.move; if (!m) return;
    if (prefersReducedMotion() || m.phase === 'committed') { this.clearMove(); return; }
    m.phase = 'cancel';
    this.moveSpring.x.setTarget(0, { damping: 1, response: 0.3 }); this.moveSpring.y.setTarget(0, { damping: 1, response: 0.3 });
    this.onMoveDrag(null); this.animateOverlay();
  }
  /** Drop the drag preview (the proposal's diff takes over, or the user cancelled). */
  clearMove() {
    if (!this.move) return;
    this.move = null; this.excluded = null; this.buildBatches(); this.invalidate(); this.onMoveDrag(null); this.updateCursor();
  }
  stepMove(dt) {
    const m = this.move; if (!m || m.phase === 'drag' || m.phase === 'committed') return true;
    this.moveSpring.x.step(dt); this.moveSpring.y.step(dt);
    if (!(this.moveSpring.x.settled() && this.moveSpring.y.settled())) return false;
    if (m.phase === 'cancel') { this.clearMove(); return true; }
    m.phase = 'committed'; this.onMoveDrag(null);
    this.onMoveCommit({ ids: m.ids, dx: m.model[0], dy: m.model[1] });
    return true;
  }
  onDouble(e) {
    if (!this.scene) return;
    const [x, y] = this.local(e), [px, py] = this.toPaper(x, y), hit = this.hitTest(px, py, 6 / this.cam.z);
    if (this.selection.size) this.fitSelection();
    else if (hit >= 0) this.fit(this.boundsOf([hit]), { padding: 96 });
    else this.fitAll();
  }
  queueHover(x, y) {
    this.hoverAt = [x, y];
    if (this.hoverQueued) return; this.hoverQueued = true;
    requestAnimationFrame(() => {
      this.hoverQueued = false; if (!this.scene || this.drag) return;
      const [px, py] = this.toPaper(...this.hoverAt);
      this.setHover(this.hitTest(px, py, 6 / this.cam.z));
    });
  }
  setHover(i) { if (i === this.hover) return; this.hover = i; this.onHover(i); this.updateCursor(); this.dirty.overlay = true; this.request(); }
  setSpace(down) { this.space = down; this.updateCursor(); }
  updateCursor() {
    const c = this.drag?.mode === 'pan' || this.drag?.mode === 'move' ? 'grabbing' : this.space || this.tool === 'pan' ? 'grab'
      : this.hover >= 0 && this.selection.has(this.hover) && this.canMove() ? 'move' : this.hover >= 0 ? 'pointer' : 'crosshair';
    if (this.overlay.style.cursor !== c) this.overlay.style.cursor = c;
  }

  // ---- render ----------------------------------------------------------------------------------------------------------
  request() { if (this.frame) return; this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); }); }
  animateOverlay() {
    if (this.overlayLoop?.running) return;
    this.overlayLoop = frameLoop(dt => {
      this.halo.step(dt); this.diffT.step(dt); this.snapPulse.step(dt);
      const moveDone = this.stepMove(dt);
      this.dirty.overlay = true; this.request();
      return !(this.halo.settled() && this.diffT.settled() && this.snapPulse.settled() && moveDone);
    });
  }
  render() {
    if (this.dirty.base) { this.dirty.base = false; this.renderBase(); }
    if (this.dirty.overlay) { this.dirty.overlay = false; this.renderOverlay(); }
  }
  viewRect(pad = 0) { const a = this.toPaper(-pad, this.H + pad), b = this.toPaper(this.W + pad, -pad); return [a[0], a[1], b[0], b[1]]; }
  paperTransform(ctx, dx = 0, dy = 0) {
    const { z, cx, cy } = this.cam, d = this.dpr;
    ctx.setTransform(z * d, 0, 0, -z * d, (this.W / 2 - (cx - dx) * z) * d, (this.H / 2 + (cy - dy) * z) * d);
  }
  lineWidthFor(color, scale = 1) {
    const mm = this.palette.width[color] ?? 0.13, px = Math.min(8, Math.max(0.75, mm * this.cam.z * scale));
    return px / this.cam.z;
  }
  dashFor(style, ctx) {
    const pat = DASH[style];
    if (!pat) { ctx.setLineDash([]); return 1; }
    const period = pat.reduce((a, b) => a + b, 0) * this.cam.z;
    if (period < 5) { ctx.setLineDash([]); return style === 9 ? 0.25 : 0.55; } // too small to read: solid, lighter
    ctx.setLineDash(pat); return style === 9 ? 0.45 : 1;
  }
  renderBase() {
    const ctx = this.bctx, d = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.base.width, this.base.height);
    if (!this.scene) return;
    this.drawSet(ctx, this);
    void d;
    for (const layer of this.compares ?? []) if (layer.set) this.renderCompare(layer);
  }
  /**
   * History scrub: other scenes drawn into their own canvases (cross-faded with CSS opacity, redrawn only when the
   * camera or the scene changes — never per scrub frame). `sets` caches batches per scene object.
   */
  setCompareLayer(i, scene) {
    const layer = this.compares?.[i]; if (!layer) return;
    if (layer.scene === scene) return;
    layer.scene = scene;
    if (!scene) { layer.set = null; const c = layer.canvas.getContext('2d'); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, layer.canvas.width, layer.canvas.height); return; }
    this.setCache ??= new WeakMap();
    let set = this.setCache.get(scene);
    if (!set || set.hiddenKey !== [...this.hidden].join()) { set = { ...batchScene(scene, { hidden: this.hidden, bbox: scene.bbox ?? this.bbox }), hiddenKey: [...this.hidden].join() }; this.setCache.set(scene, set); }
    layer.set = set; this.renderCompare(layer);
  }
  renderCompare(layer) {
    const c = layer.canvas, ctx = c.getContext('2d');
    if (c.width !== this.base.width || c.height !== this.base.height) { c.width = this.base.width; c.height = this.base.height; }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
    this.drawSet(ctx, layer.set);
  }
  drawSet(ctx, set) {
    const view = this.viewRect(8), pal = this.palette;
    this.paperTransform(ctx);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of set.solids) {
      if (!touches(s._b, view)) continue;
      ctx.fillStyle = s.rgb !== undefined ? solidColor(s.rgb) : pal.rgb[s.c] ?? pal.fg; ctx.globalAlpha = 0.9;
      const path = new Path2D(); tracePrim(path, s); ctx.fill(path);
    }
    ctx.globalAlpha = 1;
    for (const b of set.batches) {
      if (!touches(b.bbox, view)) continue;
      const color = pal.rgb[b.color] ?? pal.fg;
      if (b.point) { ctx.fillStyle = color; ctx.fill(b.path); continue; }
      ctx.strokeStyle = color; ctx.lineWidth = this.lineWidthFor(b.color); ctx.globalAlpha = this.dashFor(b.style, ctx);
      ctx.stroke(b.path);
    }
    ctx.globalAlpha = 1; ctx.setLineDash([]);
    this.drawTexts(ctx, set.texts, view, t => pal.rgb[t.c] ?? pal.fg);
  }
  drawTexts(ctx, texts, view, colorOf, dx = 0, dy = 0, alpha = 1) {
    const z = this.cam.z, d = this.dpr; let drawn = 0;
    ctx.save(); ctx.setTransform(d, 0, 0, d, 0, 0); ctx.textBaseline = 'ideographic'; ctx.globalAlpha = alpha;
    for (const t of texts) {
      const px = (t.h || 0) * z;
      if (px < 3.5 || !touches(t._b, view) || this.hidden.has(t.l)) continue;
      if (++drawn > 6000) break;
      const [sx, sy] = this.toScreen(t.p[0] + dx, t.p[1] + dy);
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(-(t.a || 0) * Math.PI / 180);
      ctx.scale((t.wd || t.h) / (t.h || 1), 1);
      ctx.font = `${px.toFixed(2)}px "Hiragino Sans","Yu Gothic UI","Yu Gothic","Meiryo",sans-serif`;
      ctx.fillStyle = colorOf(t); ctx.fillText(t.tx, 0, 0); ctx.restore();
    }
    ctx.restore();
  }
  strokeEntity(ctx, i, { color, width, alpha = 1, dx = 0, dy = 0, prims = this.scene.prims, list = this.entPrims[i] }) {
    const path = new Path2D(); let texts = [];
    for (const pi of list ?? []) { const p = prims[pi]; if (p.t === 4) texts.push(p); else tracePrim(path, p, dx, dy); }
    ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width / this.cam.z; ctx.stroke(path);
    for (const t of texts) { const pad = 0.6 / this.cam.z * 2; ctx.strokeRect(t._b[0] + dx - pad, t._b[1] + dy - pad, t._b[2] - t._b[0] + pad * 2, t._b[3] - t._b[1] + pad * 2); }
    return texts;
  }
  renderOverlay() {
    const ctx = this.octx, d = this.dpr, accent = this.accent ?? '#0a84ff';
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!this.scene) return;
    this.paperTransform(ctx); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([]);
    // diff: removed ghosts, motion trails, added geometry sliding into place
    if (this.diff) {
      const diff = this.diff, t = this.diffT.value, ghost = this.colors?.remove ?? '#ff453a', add = this.colors?.add ?? '#30d158';
      ctx.setLineDash([1.2 / this.cam.z * 4, 1.2 / this.cam.z * 3]);
      for (const i of diff.removed) this.strokeEntity(ctx, i, { color: ghost, width: 1.4, alpha: 0.75 - 0.3 * t });
      ctx.setLineDash([]);
      for (const m of diff.moves) {
        const be = this.scene.ents[m.from]; if (!be?.b) continue;
        const c = [(be.b[0] + be.b[2]) / 2, (be.b[1] + be.b[3]) / 2], e = [c[0] + m.d[0] * t, c[1] + m.d[1] * t];
        const [ax, ay] = this.toScreen(...c), [bx, by] = this.toScreen(...e);
        ctx.save(); ctx.setTransform(d, 0, 0, d, 0, 0);
        const grad = ctx.createLinearGradient(ax, ay, bx, by); grad.addColorStop(0, 'rgba(10,132,255,0)'); grad.addColorStop(1, accent);
        ctx.strokeStyle = grad; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        const ang = Math.atan2(by - ay, bx - ax), L = Math.min(10, Math.hypot(bx - ax, by - ay) * 0.4);
        if (L > 2) { ctx.fillStyle = accent; ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx - L * Math.cos(ang - 0.45), by - L * Math.sin(ang - 0.45)); ctx.lineTo(bx - L * Math.cos(ang + 0.45), by - L * Math.sin(ang + 0.45)); ctx.closePath(); ctx.fill(); }
        ctx.restore(); this.paperTransform(ctx);
      }
      const prims = diff.added.prims, byEnt = new Map();
      prims.forEach((p, i) => (byEnt.get(p.e) ?? byEnt.set(p.e, []).get(p.e)).push(i));
      for (const [ai, list] of byEnt) {
        const mv = diff.movedTo.get(ai), off = mv ? [-mv.d[0] * (1 - t), -mv.d[1] * (1 - t)] : [0, 0];
        const alpha = mv ? 1 : t;
        this.strokeEntity(ctx, ai, { color: add, width: 7, alpha: 0.18 * alpha, dx: off[0], dy: off[1], prims, list });
        const texts = this.strokeEntity(ctx, ai, { color: add, width: 1.8, alpha, dx: off[0], dy: off[1], prims, list });
        if (texts.length) this.drawTexts(ctx, texts, this.viewRect(8), () => add, off[0], off[1], alpha);
        this.paperTransform(ctx);
      }
      ctx.globalAlpha = 1;
    }
    // selection halo (expands into place once) + crisp stroke
    if (this.selection.size) {
      const h = this.halo.value, list = [...this.selection].filter(i => !this.diff?.removedSet.has(i)).slice(0, 4000);
      const mv = this.move, ox = mv ? this.moveSpring.x.value : 0, oy = mv ? this.moveSpring.y.value : 0;
      if (mv) { // where it was: a faint dashed ghost (the originals are lifted out of the base layer while moving)
        ctx.setLineDash([3 / this.cam.z, 3 / this.cam.z]);
        for (const i of list) this.strokeEntity(ctx, i, { color: accent, width: 1, alpha: 0.4 });
        ctx.setLineDash([]); this.paperTransform(ctx);
      }
      for (const i of list) this.strokeEntity(ctx, i, { color: accent, width: mv ? 6 : 10 - 4 * h, alpha: mv ? 0.16 : 0.22 * h, dx: ox, dy: oy });
      this.paperTransform(ctx);
      for (const i of list) {
        const texts = this.strokeEntity(ctx, i, { color: accent, width: 1.75, alpha: 1, dx: ox, dy: oy });
        if (mv && texts.length) { this.drawTexts(ctx, texts, this.viewRect(8), () => accent, ox, oy); this.paperTransform(ctx); }
      }
      this.paperTransform(ctx);
      if (mv) this.drawMoveGuides(ctx, ox, oy, accent);
    }
    if (this.hover >= 0 && !this.selection.has(this.hover) && !this.move) {
      this.strokeEntity(ctx, this.hover, { color: accent, width: 5, alpha: 0.16 });
      this.paperTransform(ctx);
      this.strokeEntity(ctx, this.hover, { color: accent, width: 1.4, alpha: 0.85 });
    }
    ctx.globalAlpha = 1;
    const m = this.drag;
    if (m?.mode === 'marquee') {
      ctx.setTransform(d, 0, 0, d, 0, 0);
      const x = Math.min(m.x0, m.x), y = Math.min(m.y0, m.y), w = Math.abs(m.x - m.x0), hgt = Math.abs(m.y - m.y0), crossing = m.x < m.x0;
      ctx.fillStyle = crossing ? (this.colors?.crossFill ?? 'rgba(48,209,88,0.10)') : (this.colors?.windowFill ?? 'rgba(10,132,255,0.10)');
      ctx.strokeStyle = crossing ? (this.colors?.add ?? '#30d158') : accent; ctx.lineWidth = 1;
      ctx.setLineDash(crossing ? [5, 4] : []);
      ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w, hgt, 3); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  /** Snap indicator: endpoint ring (pulses on the detent), module guide lines, and the trail from the grabbed vertex. */
  drawMoveGuides(ctx, ox, oy, accent) {
    const m = this.move, r = m.result, d = this.dpr, snap = m.phase === 'drag' ? r?.snap : null, pulse = this.snapPulse.value;
    ctx.save(); ctx.setTransform(d, 0, 0, d, 0, 0); ctx.lineWidth = 1;
    const anchor = m.ref ?? m.grab, [ax, ay] = this.toScreen(anchor[0], anchor[1]), [bx, by] = this.toScreen(anchor[0] + ox, anchor[1] + oy);
    ctx.strokeStyle = accent; ctx.globalAlpha = 0.55; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = 0.9; ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(ax, ay, 2, 0, Math.PI * 2); ctx.fill();
    if (snap?.kind === 'grid') {
      ctx.setLineDash([4, 4]);
      if (snap.axes.x) { ctx.globalAlpha = snap.major.x ? 0.7 : 0.4; ctx.beginPath(); ctx.moveTo(bx, 0); ctx.lineTo(bx, this.H); ctx.stroke(); }
      if (snap.axes.y) { ctx.globalAlpha = snap.major.y ? 0.7 : 0.4; ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(this.W, by); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    if (snap?.kind === 'endpoint' || (snap && r.engaged)) {
      const [sx, sy] = snap.kind === 'endpoint' ? this.toScreen(snap.point[0], snap.point[1]) : [bx, by];
      ctx.globalAlpha = r.engaged ? 1 : 0.5; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx, sy, 5.5 * (r.engaged ? pulse : 1), 0, Math.PI * 2); ctx.stroke();
      if (r.engaged) { ctx.globalAlpha = 0.18 * Math.min(1, pulse); ctx.beginPath(); ctx.arc(sx, sy, 9 * pulse, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore(); this.paperTransform(ctx);
  }
  destroy() { this.resize.disconnect(); this.stopCamera(); this.stopMomentum(); this.overlayLoop?.stop(); }
}
