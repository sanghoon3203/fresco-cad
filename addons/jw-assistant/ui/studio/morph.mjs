// Shared-element morph: the command bar grows into the proposal card and shrinks back along the same path.
// The card is bottom-anchored over the bar (same width, same corner radius). One spring drives the *visible height*
// v (bar height → card height); the card is revealed with clip-path inset(top) so corners and text never distort, a
// separate shadow plate follows with scaleY (transform only), and content cross-fades in after the surface has started
// to grow (and out before it shrinks). Content changes while open (progress → proposal) re-target the same spring from
// the presented height, so a resize mid-morph stays continuous. Reduced motion: plain cross-fade, no growth.
import { animate, prefersReducedMotion } from '../motion.mjs';

const OPEN = { damping: 0.88, response: 0.34 }, CLOSE = { damping: 1, response: 0.26 }, RESIZE = { damping: 1, response: 0.3 };
const clamp01 = v => Math.max(0, Math.min(1, v));

export function createMorph({ card, bar, content, radius = 18 }) {
  const plate = document.createElement('div');
  plate.className = 'morph-shadow'; plate.setAttribute('aria-hidden', 'true'); plate.hidden = true;
  card.before(plate);
  const s = { v: 0 };
  let H = 0, barH = 52, mode = 'closed', fadeFrom = 0, onClosed = null;

  function measure() {
    card.style.minHeight = '';
    H = card.offsetHeight; barH = bar.offsetHeight || 52;
    plate.style.height = `${H}px`;
  }
  function apply() {
    const v = Math.max(0, s.v), top = Math.max(0, H - v);
    const p = clamp01((v - barH) / Math.max(1, H - barH));
    if (prefersReducedMotion()) { card.style.clipPath = ''; return; }
    card.style.clipPath = top > 0.5 ? `inset(${top.toFixed(1)}px 0 0 0 round ${radius}px)` : '';
    plate.style.transform = `scaleY(${clamp01(v / Math.max(1, H)).toFixed(4)})`;
    if (mode === 'opening' || mode === 'closing') {
      // surface first, then content (open); content first, then surface (close)
      const c = mode === 'opening' ? clamp01((p - 0.28) / 0.5) : clamp01((p - 0.1) / 0.45);
      content.style.opacity = String(Math.round(c * 1000) / 1000);
      content.style.transform = `translate3d(0, ${((1 - c) * 8).toFixed(2)}px, 0)`;
      const surface = clamp01(p / 0.12 + (mode === 'closing' ? 0 : fadeFrom));
      card.style.opacity = plate.style.opacity = String(Math.round(surface * 1000) / 1000);
    }
  }
  const settle = () => { card.style.minHeight = ''; content.style.transform = ''; content.style.opacity = '1'; card.style.opacity = plate.style.opacity = '1'; card.style.clipPath = ''; };

  return {
    get open() { return mode === 'open' || mode === 'opening' || mode === 'resizing'; },
    /** Grow out of the bar. Safe to call again while open (acts as resize). */
    show() {
      if (this.open) { this.resize(); return; }
      const wasClosing = mode === 'closing';
      card.hidden = false; plate.hidden = false; measure();
      if (prefersReducedMotion()) {
        mode = 'open'; card.style.clipPath = ''; content.style.opacity = '1'; content.style.transform = '';
        card.__motion = undefined; animate(card, { opacity: 0 }, { immediate: true }); animate(card, { opacity: 1 }, { damping: 1, response: 0.18 });
        plate.style.transform = ''; plate.style.opacity = '1'; return;
      }
      if (!wasClosing) { s.v = barH; fadeFrom = 0; } else fadeFrom = 0;
      mode = 'opening'; apply();
      animate(s, { v: H }, { ...OPEN, onUpdate: apply }).finished.then(done => { if (done && mode === 'opening') { mode = 'open'; settle(); } });
    },
    /** Content inside changed: animate the height from what is on screen now. */
    resize() {
      if (!this.open) return;
      if (prefersReducedMotion()) { measure(); return; }
      const presented = mode === 'open' ? H : s.v;
      card.style.minHeight = '';
      const target = card.offsetHeight;
      if (mode === 'open' && Math.abs(presented - target) < 1) { measure(); return; }
      if (mode === 'open') { mode = 'resizing'; s.v = presented; }
      // shrinking keeps the old box (min-height on this card only) while the clip closes over it
      const draw = () => { const k = Math.max(target, s.v); H = k; card.style.minHeight = k > target + 0.5 ? `${k.toFixed(1)}px` : ''; plate.style.height = `${k}px`; apply(); };
      draw();
      animate(s, { v: target }, { ...RESIZE, onUpdate: draw }).finished.then(done => {
        if (done && (mode === 'resizing' || mode === 'opening')) { mode = 'open'; settle(); measure(); plate.style.transform = ''; }
      });
    },
    /** One horizontal nudge (failure feedback on the causal frame): the whole dock (card, shadow, bar) moves as one. */
    nudge(velocity = -900) {
      if (prefersReducedMotion()) return;
      const dock = card.parentElement; dock.__motion = undefined;
      animate(dock, { x: 0 }, { damping: 0.8, response: 0.35, velocity: { x: velocity } });
    },
    /** Shrink back into the bar, then hide. */
    hide(cb) {
      if (mode === 'closed' || mode === 'closing') { cb?.(); return; }
      onClosed = cb ?? null;
      if (prefersReducedMotion()) {
        mode = 'closing';
        animate(card, { opacity: 0 }, { damping: 1, response: 0.16 }).finished.then(done => { if (done && mode === 'closing') { mode = 'closed'; card.hidden = plate.hidden = true; card.style.opacity = '1'; onClosed?.(); } });
        return;
      }
      if (mode === 'open') { measure(); s.v = H; }
      mode = 'closing'; apply();
      animate(s, { v: barH }, { ...CLOSE, onUpdate: apply }).finished.then(done => {
        if (!done || mode !== 'closing') return;
        mode = 'closed'; card.hidden = true; plate.hidden = true; settle(); onClosed?.();
      });
    }
  };
}
