// History timeline / undo scrubber. A compact strip: one node per state (0 = as opened, k = after the k-th accepted
// edit), the playhead sits on the current state. Hover a node → thumbnail card (hover intent, warm neighbours are
// instant). Drag the playhead → the canvas cross-fades between neighbouring states 1:1 (magnetic detent at nodes);
// release projects the flick and snaps to the nearest node, previewing it with a "restore" action. Click a node →
// restore (undo back to that point; saved files stay). Esc or the current node ends a preview.
import { animate, detent, projectSnap, VelocityTracker, prefersReducedMotion } from '../motion.mjs';

const GAP = 22, THUMB_W = 196, THUMB_H = 124;

export function createHistory({ host, t, palette, renderThumb, onScrub, onRestore, onPreviewEnd }) {
  const el = document.createElement('div'); el.className = 'history material'; el.hidden = true;
  el.setAttribute('role', 'group');
  const track = document.createElement('div'); track.className = 'h-track';
  const rail = document.createElement('div'); rail.className = 'h-rail';
  const head = document.createElement('button'); head.type = 'button'; head.className = 'h-head'; head.setAttribute('role', 'slider');
  const label = document.createElement('span'); label.className = 'h-label';
  const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'btn small primary h-restore'; restore.hidden = true;
  track.append(rail); el.append(label, track, restore); host.append(el);
  const card = document.createElement('div'); card.className = 'h-card'; card.hidden = true; card.setAttribute('aria-hidden', 'true');
  const cardCanvas = document.createElement('canvas'), cardText = document.createElement('div');
  cardCanvas.width = THUMB_W * (globalThis.devicePixelRatio || 1); cardCanvas.height = THUMB_H * (globalThis.devicePixelRatio || 1);
  card.append(cardCanvas, cardText); document.body.append(card);

  let entries = [], nodes = [], pos = { p: 0 }, preview = null, drag = null, hoverTimer = 0, warmUntil = 0, cardFor = -1;
  const n = () => entries.length;
  const xOf = k => 8 + k * GAP;

  function render() {
    el.hidden = !entries.length;
    rail.replaceChildren(); nodes = [];
    track.style.width = `${xOf(n()) + 8}px`;
    for (let k = 0; k <= n(); k++) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'h-node'; b.dataset.k = String(k);
      b.style.left = `${xOf(k) - 6}px`;
      b.setAttribute('aria-label', k === 0 ? t('historyOrigin') : `${k}. ${entries[k - 1].label}`);
      if (k === n()) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', e => { if (drag?.moved) return; e.stopPropagation(); k === n() ? endPreview() : onRestore(k); });
      b.addEventListener('pointerenter', () => hoverNode(k)); b.addEventListener('pointerleave', () => unhover());
      b.addEventListener('focus', () => showCard(k)); b.addEventListener('blur', () => unhover());
      rail.append(b); nodes.push(b);
    }
    rail.append(head);
    head.setAttribute('aria-valuemin', '0'); head.setAttribute('aria-valuemax', String(n())); head.setAttribute('aria-label', t('historyScrub'));
    label.textContent = t('historyCount', { n: n() });
    restore.textContent = t('historyRestore');
    placeHead(preview ?? n(), { instant: true });
  }
  function placeHead(p, { instant = false, velocity } = {}) {
    head.setAttribute('aria-valuenow', String(Math.round(p)));
    if (instant || prefersReducedMotion()) { animate(head, { x: xOf(p) - 7 }, { immediate: true }); pos.p = p; return; }
    animate(head, { x: xOf(p) - 7 }, { damping: 0.82, response: 0.3, ...(Number.isFinite(velocity) ? { velocity: velocity * GAP } : {}) });
    animate(pos, { p }, { damping: 0.82, response: 0.3, ...(Number.isFinite(velocity) ? { velocity } : {}), onUpdate: () => onScrub(pos.p) });
  }
  // ---- hover thumbnails (intent delay, warm neighbours instant) ----
  function hoverNode(k) {
    clearTimeout(hoverTimer);
    if (drag) return;
    if (performance.now() < warmUntil || !card.hidden) showCard(k); else hoverTimer = setTimeout(() => showCard(k), 260);
  }
  function unhover() { clearTimeout(hoverTimer); if (!card.hidden) warmUntil = performance.now() + 350; card.hidden = true; cardFor = -1; }
  function showCard(k) {
    if (cardFor === k && !card.hidden) return;
    cardFor = k; const wasHidden = card.hidden; card.hidden = false;
    renderThumb(cardCanvas, k, THUMB_W, THUMB_H);
    const e = entries[k - 1];
    cardText.replaceChildren();
    const title = document.createElement('strong'); title.textContent = k === 0 ? t('historyOrigin') : e.label;
    const sub = document.createElement('small'); sub.textContent = k === 0 ? '' : `${e.time} · ${e.file ?? ''}`;
    cardText.append(title, sub);
    const r = nodes[k].getBoundingClientRect(), cw = THUMB_W + 16;
    card.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - cw - 8, r.left + r.width / 2 - cw / 2)))}px`;
    card.style.top = `${Math.round(r.bottom + 10)}px`;
    card.style.transformOrigin = `${Math.round(r.left + r.width / 2 - parseFloat(card.style.left))}px 0`;
    card.__motion = undefined;
    if (wasHidden && performance.now() >= warmUntil && !prefersReducedMotion()) { animate(card, { scale: 0.96, opacity: 0 }, { immediate: true }); animate(card, { scale: 1, opacity: 1 }, { damping: 1, response: 0.2 }); }
    else animate(card, { scale: 1, opacity: 1 }, { immediate: true });
  }
  // ---- scrubbing ----
  const localX = e => e.clientX - track.getBoundingClientRect().left;
  const pFromX = x => Math.max(0, Math.min(n(), (x - 8) / GAP));
  head.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !n()) return;
    e.preventDefault(); head.setPointerCapture(e.pointerId); unhover();
    const x = localX(e);
    drag = { off: x - xOf(pos.p), vt: new VelocityTracker(), moved: false }; drag.vt.add(x, 0, e.timeStamp);
    el.classList.add('scrubbing');
  });
  head.addEventListener('pointermove', e => {
    if (!drag) return;
    const x = localX(e); drag.vt.add(x, 0, e.timeStamp);
    if (Math.abs(x - drag.off - xOf(pos.p)) > 2) drag.moved = true;
    const raw = pFromX(x - drag.off), k = Math.round(raw), p = detent(raw, k, 0.32, 2); // nodes are soft detents
    animate(head, { x: xOf(p) - 7 }, { immediate: true }); animate(pos, { p }, { immediate: true });
    head.setAttribute('aria-valuenow', String(k));
    onScrub(p);
  });
  const up = e => {
    if (!drag) return;
    const v = drag.vt.velocity(e.timeStamp).x / GAP, moved = drag.moved; drag = null; el.classList.remove('scrubbing');
    if (!moved) return;
    const target = projectSnap(pos.p, v, { step: 1, min: 0, max: n(), rate: 0.99, reach: 1 }).value;
    const k = Math.round(target);
    setPreview(k === n() ? null : k, v);
  };
  head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
  head.addEventListener('keydown', e => {
    const cur = preview ?? n();
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const k = Math.max(0, Math.min(n(), cur + (e.key === 'ArrowLeft' ? -1 : 1))); setPreview(k === n() ? null : k, undefined, true); }
    if (e.key === 'Enter' && preview !== null) onRestore(preview);
  });
  restore.addEventListener('click', () => { if (preview !== null) onRestore(preview); });

  function setPreview(k, velocity, keyboard = false) {
    preview = k; restore.hidden = k === null;
    el.classList.toggle('previewing', k !== null);
    if (keyboard) { placeHead(k ?? n(), { instant: true }); onScrub(k ?? n()); } else placeHead(k ?? n(), { velocity });
    if (k === null) onPreviewEnd?.();
  }
  function endPreview() { if (preview !== null || pos.p !== n()) setPreview(null); }

  return {
    el,
    /** Replace the entries ({ label, time, file }) — the current state is entries.length. */
    set(list) { entries = list.slice(); preview = null; restore.hidden = true; el.classList.remove('previewing'); render(); },
    endPreview,
    get previewing() { return preview !== null || !!drag; }
  };
}
