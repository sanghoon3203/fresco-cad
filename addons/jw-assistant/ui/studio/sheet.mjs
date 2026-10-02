// Popovers/sheets that materialize out of their trigger (transform-origin at the trigger) and return the same way.
// Keyboard-opened sheets appear instantly (frequent, keyboard-initiated actions are not animated).
import { animate, prefersReducedMotion, SPRINGS } from '../motion.mjs';

const open = new Set();
export function originFor(sheet, trigger) {
  if (!trigger) return 'center';
  const t = trigger.getBoundingClientRect(), s = sheet.getBoundingClientRect();
  return `${Math.round(t.left + t.width / 2 - s.left)}px ${Math.round(t.top + t.height / 2 - s.top)}px`;
}

/** Show `sheet` (an element with [hidden]) from `trigger`. Returns a close() function. */
export function showSheet(sheet, trigger, { keyboard = false, onClose, focus = true } = {}) {
  if (open.has(sheet)) return () => hideSheet(sheet);
  sheet.hidden = false; open.add(sheet);
  sheet._trigger = trigger; sheet._onClose = onClose;
  sheet.style.transformOrigin = originFor(sheet, trigger);
  if (keyboard || prefersReducedMotion()) {
    sheet.__motion = undefined;
    animate(sheet, { scale: keyboard ? 1 : 1, opacity: keyboard ? 1 : 0 }, { immediate: true });
    if (!keyboard) animate(sheet, { opacity: 1 }, SPRINGS.snappy);
  } else {
    sheet.__motion = undefined;
    animate(sheet, { scale: 0.94, opacity: 0, y: 0 }, { immediate: true });
    animate(sheet, { scale: 1, opacity: 1 }, SPRINGS.sheet);
  }
  sheet.classList.add('is-open');
  // keyboard users land on the first control; pointer users get the sheet itself (no stray focus ring)
  if (focus) requestAnimationFrame(() => ((keyboard && sheet.querySelector('[autofocus], input, select, textarea, button:not([data-close])')) || sheet).focus({ preventScroll: true }));
  return () => hideSheet(sheet);
}
export function hideSheet(sheet, { restoreFocus = true } = {}) {
  if (!open.has(sheet)) return;
  open.delete(sheet); sheet.classList.remove('is-open');
  const done = () => { if (!open.has(sheet)) sheet.hidden = true; };
  if (prefersReducedMotion()) animate(sheet, { opacity: 0 }, SPRINGS.snappy).finished.then(done);
  else animate(sheet, { scale: 0.96, opacity: 0 }, SPRINGS.snappy).finished.then(done);
  if (restoreFocus && sheet.contains(document.activeElement)) sheet._trigger?.focus?.({ preventScroll: true });
  sheet._onClose?.();
}
export const isOpen = sheet => open.has(sheet);
export function topSheet() { return [...open].at(-1) ?? null; }
// Click outside closes popovers (not the proposal sheet, which owns its own lifecycle).
document.addEventListener('pointerdown', e => {
  for (const s of [...open]) if (s.dataset.popover !== undefined && !s.contains(e.target) && !s._trigger?.contains(e.target)) hideSheet(s, { restoreFocus: false });
}, true);
