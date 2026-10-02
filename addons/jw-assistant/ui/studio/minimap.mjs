// Minimap: a cached thumbnail of the whole drawing plus the camera's viewport rectangle. The rectangle *tracks* the
// camera through a stiff critically-damped spring (smooths wheel steps, never lags a drag noticeably); dragging the
// rectangle moves the camera 1:1 (grab offset respected), and a flick is projected with Apple's deceleration, clamped to
// the drawing, then handed to the camera spring with the release velocity. Appears only when the view no longer shows
// the whole drawing (it has nothing to say at "fit"). Reduced motion: no tracking spring, no momentum.
import { animate, VelocityTracker, projectSnap, prefersReducedMotion } from '../motion.mjs';

const W = 184, H = 124, PAD = 8, TRACK = { damping: 1, response: 0.12 };

export function createMinimap({ host, view, label = '' }) {
  const el = document.createElement('div');
  el.className = 'minimap material'; el.hidden = true; el.setAttribute('role', 'img'); if (label) el.setAttribute('aria-label', label);
  const thumb = document.createElement('canvas'), over = document.createElement('canvas');
  thumb.className = 'mm-thumb'; over.className = 'mm-over';
  el.append(thumb, over); host.append(el);
  const dpr = () => globalThis.devicePixelRatio || 1;
  for (const c of [thumb, over]) { c.width = W * dpr(); c.height = H * dpr(); }
  let map = null, rect = { x: 0, y: 0, w: 0, h: 0 }, drag = null, visible = false, scene = null;
  const vis = { o: 0 };

  function fitMap(b) {
    const w = Math.max(b[2] - b[0], 1e-6), h = Math.max(b[3] - b[1], 1e-6), k = Math.min((W - PAD * 2) / w, (H - PAD * 2) / h);
    return { b, k, ox: (W - w * k) / 2, oy: (H - h * k) / 2 };
  }
  const toMini = (x, y) => [map.ox + (x - map.b[0]) * map.k, H - (map.oy + (y - map.b[1]) * map.k)];
  const toPaper = (mx, my) => [map.b[0] + (mx - map.ox) / map.k, map.b[1] + (H - my - map.oy) / map.k];

  function setScene(s) {
    scene = s; map = s?.bbox ? fitMap(s.bbox) : null; drawThumb(); update({ instant: true });
  }
  function drawThumb() {
    const ctx = thumb.getContext('2d'), d = dpr();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, thumb.width, thumb.height);
    if (!scene || !map) return;
    ctx.setTransform(d * map.k, 0, 0, -d * map.k, d * (map.ox - map.b[0] * map.k), d * (H - map.oy + map.b[1] * map.k));
    const path = new Path2D();
    for (const p of scene.prims) {
      if (p.t === 4 || view.hidden.has(p.l)) continue;
      const q = p.p; if (q.length < 4) continue;
      path.moveTo(q[0], q[1]); for (let i = 2; i < q.length; i += 2) path.lineTo(q[i], q[i + 1]);
    }
    ctx.strokeStyle = view.palette.fg; ctx.globalAlpha = 0.55; ctx.lineWidth = 0.8 / (map.k * d) * d; ctx.stroke(path);
  }
  function drawRect() {
    const ctx = over.getContext('2d'), d = dpr();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, over.width, over.height);
    if (!map) return;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const accent = view.accent ?? '#0a84ff';
    // dim outside the viewport, keep inside clear: reads as a window onto the drawing
    ctx.fillStyle = 'rgba(0,0,0,0.10)'; ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.fill('evenodd');
    ctx.strokeStyle = accent; ctx.lineWidth = drag ? 2 : 1.5; ctx.beginPath(); ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 2); ctx.stroke();
  }
  function targetRect() {
    const v = view.viewRect(0), [x1, y1] = toMini(v[0], v[3]), [x2, y2] = toMini(v[2], v[1]);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  /** Camera moved: track it with the spring (or jump). Also decides whether the minimap is worth showing. */
  function update({ instant = false } = {}) {
    if (!map) { show(false); return; }
    const fitZ = view.cameraFor(view.bbox ?? scene.bbox).z;
    show(view.cam.z > fitZ * 1.2 || !!drag);
    const t = targetRect();
    if (instant || drag || prefersReducedMotion() || !visible) { Object.assign(rect, t); animate(rect, t, { immediate: true }); drawRect(); return; }
    animate(rect, t, { ...TRACK, onUpdate: drawRect });
  }
  function show(on) {
    if (on === visible) return;
    visible = on;
    if (on) el.hidden = false;
    animate(vis, { o: on ? 1 : 0 }, { damping: 1, response: on ? 0.22 : 0.18, onUpdate: () => { el.style.opacity = String(vis.o); el.style.transform = prefersReducedMotion() ? '' : `scale(${(0.96 + 0.04 * vis.o).toFixed(4)})`; } })
      .finished.then(done => { if (done && !visible) el.hidden = true; });
  }
  // ---- gestures ----
  const local = e => { const r = over.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  over.addEventListener('pointerdown', e => {
    if (!map || e.button !== 0) return;
    e.preventDefault(); over.setPointerCapture(e.pointerId);
    view.stopCamera(); view.stopMomentum();
    const [mx, my] = local(e), inside = mx >= rect.x && mx <= rect.x + rect.w && my >= rect.y && my <= rect.y + rect.h;
    // grab offset: inside the rectangle keep it; outside, the rectangle's centre jumps under the pointer
    const off = inside ? [mx - (rect.x + rect.w / 2), my - (rect.y + rect.h / 2)] : [0, 0];
    drag = { off, vt: new VelocityTracker() }; drag.vt.add(mx, my, e.timeStamp);
    if (!inside) { const [px, py] = toPaper(mx, my); view.springTo({ cx: px, cy: py, z: view.cam.z }, { damping: 1, response: 0.3 }); drag.jumped = true; }
    el.classList.add('dragging'); drawRect();
  });
  over.addEventListener('pointermove', e => {
    if (!drag) return;
    const [mx, my] = local(e); drag.vt.add(mx, my, e.timeStamp);
    const [px, py] = toPaper(mx - drag.off[0], my - drag.off[1]);
    if (drag.jumped) { view.springTo({ cx: px, cy: py, z: view.cam.z }, { damping: 1, response: 0.18 }); return; } // keep chasing until settled
    view.centerOn(px, py);
  });
  const up = e => {
    if (!drag) return;
    const v = drag.vt.velocity(e.timeStamp), b = map.b;
    drag = null; el.classList.remove('dragging');
    if (prefersReducedMotion() || Math.hypot(v.x, v.y) < 60) { view.settleLimits(); update(); return; }
    // minimap px/s → paper mm/s; project the flick and clamp the centre into the drawing
    const vx = v.x / map.k, vy = -v.y / map.k, c = view.cam;
    const tx = projectSnap(c.cx, vx, { rate: 0.995, min: b[0], max: b[2] }).value, ty = projectSnap(c.cy, vy, { rate: 0.995, min: b[1], max: b[3] }).value;
    view.springTo({ cx: tx, cy: ty, z: c.z }, { damping: 1, response: 0.55 }, { cx: vx, cy: vy });
  };
  over.addEventListener('pointerup', up); over.addEventListener('pointercancel', up);
  return { el, setScene, update, redraw: () => { drawThumb(); drawRect(); } };
}
