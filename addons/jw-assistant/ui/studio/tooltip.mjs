// Hover-intent tooltips for icon controls ([data-tip]). Delay in (prevents accidental flashes), instant out, and a
// "warm" window: once one tooltip has shown, moving to a neighbour shows the next immediately with no animation.
// Fine pointers only (touch never gets false hovers); keyboard focus shows instantly. One shared element.
import { animate, prefersReducedMotion } from '../motion.mjs';

const DELAY = 550, WARM_MS = 400;
export function initTooltips(root = document) {
  const tip = document.createElement('div');
  tip.className = 'tooltip'; tip.setAttribute('role', 'tooltip'); tip.id = 'studio-tooltip'; tip.hidden = true;
  document.body.append(tip);
  let timer = 0, current = null, warmUntil = 0;
  const fine = matchMedia('(hover: hover) and (pointer: fine)');

  function place(el) {
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const below = r.top < 90; // titlebar controls: tooltip below; elsewhere above
    let x = r.left + r.width / 2 - t.width / 2; x = Math.max(8, Math.min(innerWidth - t.width - 8, x));
    const y = below ? r.bottom + 8 : r.top - t.height - 8;
    tip.style.left = `${Math.round(x)}px`; tip.style.top = `${Math.round(y)}px`;
    tip.style.transformOrigin = `${Math.round(r.left + r.width / 2 - x)}px ${below ? '0' : '100%'}`;
  }
  function show(el, instant) {
    clearTimeout(timer);
    current = el; tip.textContent = el.dataset.tip; tip.hidden = false;
    el.setAttribute('aria-describedby', tip.id);
    place(el);
    tip.__motion = undefined;
    if (instant || prefersReducedMotion()) animate(tip, { scale: 1, opacity: 1 }, { immediate: true });
    else { animate(tip, { scale: 0.97, opacity: 0 }, { immediate: true }); animate(tip, { scale: 1, opacity: 1 }, { damping: 1, response: 0.18 }); }
  }
  function hide() {
    clearTimeout(timer);
    if (!current) return;
    current.removeAttribute('aria-describedby'); current = null;
    warmUntil = performance.now() + WARM_MS;
    tip.hidden = true; // instant out
  }
  root.addEventListener('pointerover', e => {
    const el = e.target.closest?.('[data-tip]');
    if (!el || e.pointerType !== 'mouse' || !fine.matches) return;
    if (el === current) return;
    const warm = !!current || performance.now() < warmUntil;
    if (current) hide();
    clearTimeout(timer);
    if (warm) show(el, true); else timer = setTimeout(() => { if (el.matches(':hover')) show(el, false); }, DELAY);
  });
  root.addEventListener('pointerout', e => {
    const el = e.target.closest?.('[data-tip]');
    if (!el || el.contains(e.relatedTarget)) return;
    if (el === current) hide(); else clearTimeout(timer);
  });
  root.addEventListener('pointerdown', () => { clearTimeout(timer); if (current) { current.removeAttribute('aria-describedby'); current = null; tip.hidden = true; } }, true);
  root.addEventListener('focusin', e => { const el = e.target.closest?.('[data-tip]'); if (el && el.matches(':focus-visible')) show(el, true); });
  root.addEventListener('focusout', e => { if (e.target === current) hide(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && current) hide(); });
  return { hide };
}
