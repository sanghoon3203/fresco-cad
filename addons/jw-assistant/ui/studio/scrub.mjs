// Scrubbable number fields: drag a field's label horizontally to change its value (1:1 in px, Shift = ×10, Alt = ×0.1;
// changing a modifier mid-drag re-bases so the value never jumps). Past a limit the value rubber-bands and springs back
// on release (velocity handoff from the drag). The field is not committed by the scrub — Enter (or the field's own
// button) still creates the proposal, so a big drawing never recomputes per pixel. Reduced motion: the spring-back jumps.
import { animate, scrubRate, scrubValue, VelocityTracker, prefersReducedMotion } from '../motion.mjs';

const fmt = (v, decimals) => String(Math.round(v * 10 ** decimals) / 10 ** decimals);

/**
 * Make `handle` scrub `input`. opts: perPx (units per px at ×1), min, max, decimals, onChange(value), onEnd(value).
 * Returns a detach function.
 */
export function scrubbable(handle, input, { perPx = 1, min = -Infinity, max = Infinity, decimals = 1, onChange, onEnd } = {}) {
  handle.classList.add('scrub'); handle.setAttribute('aria-hidden', 'true');
  const state = { v: 0 };
  let drag = null;
  const write = v => { input.value = fmt(v, drag?.alt ? decimals + 1 : decimals); input.dispatchEvent(new Event('input', { bubbles: true })); onChange?.(v); };
  const down = e => {
    if (e.button !== 0 || input.disabled) return;
    e.preventDefault(); handle.setPointerCapture(e.pointerId);
    const start = Number(input.value) || 0;
    drag = { x0: e.clientX, start, shift: e.shiftKey, alt: e.altKey, value: start, vt: new VelocityTracker() };
    drag.vt.add(e.clientX, 0, e.timeStamp);
    document.body.classList.add('scrubbing'); handle.classList.add('active');
  };
  const move = e => {
    if (!drag) return;
    if (e.shiftKey !== drag.shift || e.altKey !== drag.alt) { // re-base at the current value: no jump on modifier change
      drag.start = Math.min(max, Math.max(min, drag.value)); drag.x0 = e.clientX; drag.shift = e.shiftKey; drag.alt = e.altKey;
    }
    drag.vt.add(e.clientX, 0, e.timeStamp);
    const r = scrubValue(drag.start, e.clientX - drag.x0, { perPx: scrubRate(perPx, drag), min, max });
    drag.value = r.value; handle.classList.toggle('over', r.over !== 0);
    write(r.value);
  };
  const up = e => {
    if (!drag) return;
    const d = drag, rate = scrubRate(perPx, d), v = d.vt.velocity(e.timeStamp).x * rate;
    drag = null; document.body.classList.remove('scrubbing'); handle.classList.remove('active', 'over');
    const clamped = Math.min(max, Math.max(min, d.value));
    const finish = () => { input.value = fmt(clamped, d.alt ? decimals + 1 : decimals); input.classList.add('pending'); input.focus({ preventScroll: true }); onEnd?.(clamped); };
    if (clamped === d.value || prefersReducedMotion()) { finish(); return; }
    state.v = d.value;
    animate(state, { v: clamped }, { damping: 1, response: 0.32, velocity: v, onUpdate: () => { input.value = fmt(state.v, decimals); } }).finished.then(finish);
  };
  handle.addEventListener('pointerdown', down); handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') input.classList.remove('pending'); });
  return () => { handle.removeEventListener('pointerdown', down); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); };
}
