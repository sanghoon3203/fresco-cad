// Odometer-style digit roll for read-only numbers that change *from elsewhere* (an accepted edit changes a length,
// a delete changes the entity count). Each digit is a 0–9 strip (twice, so a carry keeps rolling forward) moved with a
// spring; non-digits swap instantly. The plan is pure (tested); the DOM part only writes transforms.
import { animate, prefersReducedMotion } from '../motion.mjs';

const num = s => { const v = Number(String(s).replace(/[^\d.-]/gu, '')); return Number.isFinite(v) ? v : null; };

/**
 * Per-character plan for rolling `from` → `to`, right-aligned (units stay under units).
 * Returns [{ ch, digit, from, to }] for each character of `to`; for digits `from`/`to` are strip positions 0..19 chosen so
 * the strip moves in the direction of the numeric change (up = increase), wrapping through 9→0 like a real counter.
 */
export function odometerPlan(from, to) {
  const a = [...String(from ?? '')], b = [...String(to ?? '')], dir = Math.sign((num(to) ?? 0) - (num(from) ?? 0));
  const out = [];
  for (let i = 0; i < b.length; i++) {
    const ch = b[i], j = a.length - (b.length - i), prev = j >= 0 ? a[j] : undefined;
    if (!/\d/u.test(ch)) { out.push({ ch, digit: false, from: null, to: null }); continue; }
    const t = Number(ch), f = prev !== undefined && /\d/u.test(prev) ? Number(prev) : null;
    if (f === null || f === t || dir === 0) { out.push({ ch, digit: true, from: f === null ? null : (f === t ? t : f), to: t }); continue; }
    // up: strip moves so the digit comes from below (positions increase); wrap via the second copy of 0–9
    if (dir > 0) out.push({ ch, digit: true, from: f, to: t > f ? t : t + 10 });
    else out.push({ ch, digit: true, from: f + 10, to: t >= f ? t : t + 10 });
  }
  return out;
}

const cache = new WeakMap();
/** Render `text` into `el`; when `animateFrom` differs, digits roll. Keyed per element so re-renders can roll. */
export function setOdometer(el, text, { animateFrom } = {}) {
  text = String(text);
  const prev = animateFrom ?? cache.get(el);
  cache.set(el, text);
  el.classList.add('odo'); el.setAttribute('aria-label', text);
  if (prev === undefined || prev === text || prefersReducedMotion()) { el.textContent = text; return; }
  el.replaceChildren();
  const plan = odometerPlan(prev, text);
  plan.forEach((c, i) => {
    if (!c.digit || c.from === null || c.from === c.to) {
      const s = document.createElement('span'); s.className = 'odo-ch'; s.textContent = c.ch; s.setAttribute('aria-hidden', 'true');
      if (c.digit && c.from === null) { animate(s, { opacity: 0 }, { immediate: true }); animate(s, { opacity: 1 }, { damping: 1, response: 0.3 }); }
      el.append(s); return;
    }
    const cell = document.createElement('span'); cell.className = 'odo-cell'; cell.setAttribute('aria-hidden', 'true');
    const strip = document.createElement('span'); strip.className = 'odo-strip';
    strip.textContent = '01234567890123456789'.split('').join('\n');
    cell.append(strip); el.append(cell);
    // 1 line = 1em (line-height fixed in CSS); later (lower) digits settle last, like a real counter
    const lh = parseFloat(getComputedStyle(cell).height) || 16;
    animate(strip, { y: -c.from * lh }, { immediate: true });
    animate(strip, { y: -c.to * lh }, { damping: 1, response: 0.42 + (i / plan.length) * 0.12 }).finished.then(done => {
      if (done && cache.get(el) === text && el.contains(cell)) cell.replaceWith(Object.assign(document.createElement('span'), { className: 'odo-ch', textContent: c.ch }));
    });
  });
}
