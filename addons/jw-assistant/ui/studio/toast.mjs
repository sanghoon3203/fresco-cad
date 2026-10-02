// Sonner-like toasts: one stack, newest in front, older ones tucked behind; hover expands the stack; swipe up to
// dismiss with velocity (a flick is enough); springs everywhere so stack changes are interruptible.
import { animate, VelocityTracker, rubberband, prefersReducedMotion, SPRINGS } from '../motion.mjs';

const ICONS = {
  success: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9"/><path d="M6 10.4l2.6 2.6L14.2 7.4"/></svg>',
  error: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9"/><path d="M10 5.6v5.6M10 14.2v.1"/></svg>',
  info: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9"/><path d="M10 9v5M10 5.8v.1"/></svg>',
  loading: '<span class="toast-spinner" aria-hidden="true"></span>'
};
const GAP = 8, PEEK = 10, MAX_VISIBLE = 3;

export function createToaster(root) {
  const items = []; let expanded = false, seq = 0;
  root.addEventListener('pointerenter', () => { expanded = true; layout(); pauseAll(true); });
  root.addEventListener('pointerleave', () => { expanded = false; layout(); pauseAll(false); });
  document.addEventListener('visibilitychange', () => pauseAll(document.hidden));

  function pauseAll(paused) { for (const it of items) paused ? pause(it) : resume(it); }
  function pause(it) { if (it.timer) { clearTimeout(it.timer); it.timer = 0; it.remaining -= performance.now() - it.started; } }
  function resume(it) { if (!it.timer && it.remaining !== Infinity && !it.dragging && !expanded && !document.hidden) { it.started = performance.now(); it.timer = setTimeout(() => dismiss(it.id), Math.max(800, it.remaining)); } }

  function layout({ entering } = {}) {
    let y = 0;
    items.forEach((it, i) => {
      if (it.leaving) return;
      const h = it.el.offsetHeight || 56, depth = i;
      const target = expanded ? { y, scale: 1, opacity: 1 } : { y: depth * PEEK, scale: 1 - depth * 0.05, opacity: depth >= MAX_VISIBLE ? 0 : 1 - depth * 0.12 };
      it.el.style.zIndex = String(100 - i);
      it.el.toggleAttribute('inert', !expanded && depth > 0);
      it.el.setAttribute('aria-hidden', String(!expanded && depth >= MAX_VISIBLE));
      if (it === entering && !prefersReducedMotion()) { it.el.__motion = undefined; animate(it.el, { y: -18, scale: 0.96, opacity: 0 }, { immediate: true }); }
      if (!it.dragging) animate(it.el, target, SPRINGS.default);
      y += h + GAP;
    });
    root.style.height = `${expanded ? Math.max(0, y - GAP) : (items[0]?.el.offsetHeight ?? 0) + Math.min(items.length - 1, MAX_VISIBLE - 1) * PEEK}px`;
  }

  function render(it) {
    const o = it.options, el = it.el;
    el.className = `toast toast-${o.type ?? 'info'}`;
    el.setAttribute('role', o.type === 'error' ? 'alert' : 'status');
    el.replaceChildren();
    const icon = document.createElement('span'); icon.className = 'toast-icon'; icon.innerHTML = ICONS[o.type] ?? ICONS.info;
    const body = document.createElement('div'); body.className = 'toast-body';
    const title = document.createElement('div'); title.className = 'toast-title'; title.textContent = o.message; body.append(title);
    if (o.description) { const d = document.createElement('div'); d.className = 'toast-desc'; d.textContent = o.description; body.append(d); }
    el.append(icon, body);
    if (o.action) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'toast-action'; b.textContent = o.action.label;
      b.addEventListener('click', e => { e.stopPropagation(); o.action.onClick?.(); dismiss(it.id); });
      el.append(b);
    }
  }

  function bindSwipe(it) {
    const el = it.el;
    el.addEventListener('pointerdown', e => {
      if (e.target.closest('button') || e.button !== 0) return;
      it.dragging = true; pause(it); const start = e.clientY, vt = new VelocityTracker(); vt.add(0, start, e.timeStamp);
      el.setPointerCapture(e.pointerId);
      const move = ev => { const dy = ev.clientY - start; vt.add(0, ev.clientY, ev.timeStamp); it.dy = dy < 0 ? dy : rubberband(dy, 120); animate(el, { y: baseY(it) + it.dy }, { immediate: true }); };
      const up = ev => {
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
        it.dragging = false; const v = vt.velocity(ev.timeStamp).y, dy = it.dy ?? 0; it.dy = 0;
        if (dy < -40 || v < -110) dismiss(it.id, v); else { animate(el, { y: baseY(it) }, { ...SPRINGS.flick, velocity: v }); resume(it); }
      };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
  }
  const baseY = it => { const i = items.indexOf(it); return expanded ? items.slice(0, i).reduce((s, x) => s + x.el.offsetHeight + GAP, 0) : i * PEEK; };

  function show(message, options = {}) {
    const existing = options.id && items.find(x => x.id === options.id);
    if (existing) { existing.options = { ...existing.options, ...options, message }; render(existing); pause(existing); existing.remaining = durationOf(existing.options); resume(existing); layout(); return existing.id; }
    const el = document.createElement('li');
    const it = { id: options.id ?? `t${++seq}`, el, options: { ...options, message }, remaining: 0, timer: 0 };
    it.remaining = durationOf(it.options);
    render(it); bindSwipe(it);
    root.prepend(el); items.unshift(it);
    while (items.length > 6) dismiss(items.at(-1).id);
    layout({ entering: it }); resume(it);
    return it.id;
  }
  const durationOf = o => (o.duration ?? (o.type === 'loading' ? Infinity : o.type === 'error' ? 8000 : o.action ? 7000 : 4500));

  function dismiss(id, velocity = 0) {
    const it = items.find(x => x.id === id); if (!it || it.leaving) return;
    it.leaving = true; pause(it); items.splice(items.indexOf(it), 1);
    it.el.setAttribute('aria-hidden', 'true');
    animate(it.el, { y: (it.el.__motion?.y ?? 0) - 36, opacity: 0, scale: 0.98 }, { ...SPRINGS.default, velocity: { y: velocity } }).finished.then(() => it.el.remove());
    layout();
  }

  const toast = (message, options) => show(message, options);
  toast.success = (m, o = {}) => show(m, { ...o, type: 'success' });
  toast.error = (m, o = {}) => show(m, { ...o, type: 'error' });
  toast.info = (m, o = {}) => show(m, { ...o, type: 'info' });
  toast.loading = (m, o = {}) => show(m, { ...o, type: 'loading' });
  toast.dismiss = id => (id ? dismiss(id) : [...items].forEach(x => dismiss(x.id)));
  return toast;
}
