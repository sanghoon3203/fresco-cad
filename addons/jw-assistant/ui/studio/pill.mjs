// Segmented controls / tabs with one sliding selection pill (shared layout): the pill is a single element that travels
// between options instead of each option fading its own background. Moves with translateX + scaleX only (no layout per
// frame); at rest the real width is written once and scaleX returns to 1, so corners are never distorted when still.
// Keyboard-driven changes jump (no animation), pointer changes spring; reduced motion jumps.
import { animate, stopAll, prefersReducedMotion } from '../motion.mjs';

const PILL = { damping: 0.9, response: 0.3 };

/** Attach a pill to `seg` (an element whose children are buttons with aria-checked / aria-selected). Returns { sync }. */
export function attachPill(seg) {
  if (seg.__pill) return seg.__pill;
  const pill = document.createElement('span');
  pill.className = 'seg-pill'; pill.setAttribute('aria-hidden', 'true');
  seg.prepend(pill); seg.classList.add('has-pill');
  let width = 0, ready = false, run = null;
  const selected = () => [...seg.children].find(b => b !== pill && (b.getAttribute('aria-checked') === 'true' || b.getAttribute('aria-selected') === 'true'));
  function sync({ instant = false } = {}) {
    const b = selected();
    if (!b || !b.offsetWidth) { pill.style.opacity = '0'; return; }
    pill.style.opacity = '1';
    const x = b.offsetLeft, w = b.offsetWidth;
    if (!ready || instant || prefersReducedMotion()) {
      stopAll(pill); run = null; width = w; pill.style.width = `${w}px`; pill.__motion = undefined;
      animate(pill, { x, scaleX: 1 }, { immediate: true }); ready = true; return;
    }
    // travel at the current width, stretching with scaleX toward the target width; settle writes the real width
    const token = {}; run = token;
    animate(pill, { x, scaleX: w / width }, PILL).finished.then(done => {
      if (!done || run !== token) return;
      width = w; pill.style.width = `${w}px`; animate(pill, { scaleX: 1 }, { immediate: true });
    });
  }
  new ResizeObserver(() => sync({ instant: true })).observe(seg);
  const api = { sync, el: pill };
  seg.__pill = api;
  requestAnimationFrame(() => sync({ instant: true }));
  return api;
}
