// Context menu anchored to the pointer. Origin-aware: it scales out of the corner that touches the pointer (flipping
// left/up near the viewport edges, and the origin flips with it). Pointer-opened menus spring in (scale .96 → 1,
// 0.86/0.24); keyboard-opened ones (ContextMenu key / Shift+F10) appear instantly. Closing is a quick fade.
// Items: { label, kbd?, danger?, disabled?, onSelect } or 'sep'. Arrow keys / Home / End / Enter / Esc / type-ahead.
import { animate, prefersReducedMotion } from '../motion.mjs';

let menuEl = null, restoreFocus = null, onCloseCb = null;
export function closeContextMenu({ focus = true } = {}) {
  if (!menuEl) return;
  const el = menuEl; menuEl = null;
  document.removeEventListener('pointerdown', outside, true);
  window.removeEventListener('blur', blurClose);
  animate(el, { opacity: 0 }, { damping: 1, response: 0.14 }).finished.then(() => el.remove());
  if (focus) restoreFocus?.focus?.({ preventScroll: true });
  onCloseCb?.(); onCloseCb = null;
}
const outside = e => { if (menuEl && !menuEl.contains(e.target)) closeContextMenu({ focus: false }); };
const blurClose = () => closeContextMenu({ focus: false });

/** Open a context menu at client (x, y). Returns the menu element. */
export function openContextMenu(x, y, items, { keyboard = false, label = '', onClose } = {}) {
  closeContextMenu({ focus: false });
  restoreFocus = document.activeElement; onCloseCb = onClose;
  const el = document.createElement('div');
  el.className = 'ctx-menu'; el.tabIndex = -1; el.setAttribute('role', 'menu'); if (label) el.setAttribute('aria-label', label);
  for (const it of items) {
    if (it === 'sep') { const s = document.createElement('div'); s.className = 'ctx-sep'; s.setAttribute('role', 'separator'); el.append(s); continue; }
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'menuitem'); b.className = it.danger ? 'danger' : '';
    b.disabled = !!it.disabled;
    const l = document.createElement('span'); l.textContent = it.label; b.append(l);
    if (it.kbd) { const k = document.createElement('kbd'); k.textContent = it.kbd; b.append(k); }
    b.addEventListener('click', () => { closeContextMenu(); it.onSelect?.(); });
    b.addEventListener('pointermove', () => { if (!b.disabled && document.activeElement !== b) b.focus({ preventScroll: true }); });
    el.append(b);
  }
  document.body.append(el);
  const r = el.getBoundingClientRect(), flipX = x + r.width > innerWidth - 8, flipY = y + r.height > innerHeight - 8;
  const left = flipX ? Math.max(8, x - r.width) : x, top = flipY ? Math.max(8, y - r.height) : y;
  el.style.left = `${Math.round(left)}px`; el.style.top = `${Math.round(top)}px`;
  el.style.transformOrigin = `${flipX ? '100%' : '0'} ${flipY ? '100%' : '0'}`;
  if (keyboard || prefersReducedMotion()) animate(el, { opacity: 1, scale: 1 }, { immediate: true });
  else { animate(el, { opacity: 0, scale: 0.96 }, { immediate: true }); animate(el, { opacity: 1, scale: 1 }, { damping: 0.86, response: 0.24 }); }
  menuEl = el;
  const buttons = () => [...el.querySelectorAll('button:not(:disabled)')];
  el.addEventListener('keydown', e => {
    const list = buttons(), i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list.at(-1)?.focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeContextMenu(); }
    else if (e.key.length === 1 && /\S/u.test(e.key)) { const hit = list.find(b => b.textContent.trim().toLowerCase().startsWith(e.key.toLowerCase())); hit?.focus(); }
  });
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); window.addEventListener('blur', blurClose); }, 0);
  (keyboard ? buttons()[0] : el).focus({ preventScroll: true });
  return el;
}
export const contextMenuOpen = () => !!menuEl;
