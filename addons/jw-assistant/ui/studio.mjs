// Fresco Studio controller: files → scene → canvas; selection → inspector; command bar → /api/v2/edit → proposal
// (op chips + canvas diff) → accept (new JWW) / reject / undo. Server contract: tools/studio-server.mjs (/api/v2/*).
import { DrawingView } from './studio-canvas.mjs';
import { animate, SPRINGS, prefersReducedMotion, readStoredReducedMotion, storeReducedMotion, setReducedMotion } from './motion.mjs';
import { t, setLang, getLang } from './studio/i18n.mjs';
import { createToaster } from './studio/toast.mjs';
import { describeOp, summarizeOps } from './studio/ops.mjs';
import { showSheet, hideSheet, isOpen, topSheet } from './studio/sheet.mjs';
import { emptyProgress, reduceProgress, readNdjson } from './studio/progress.mjs';
import { setOdometer } from './studio/odometer.mjs';
import { createMorph } from './studio/morph.mjs';
import { scrubbable } from './studio/scrub.mjs';
import { createMinimap } from './studio/minimap.mjs';
import { createHistory } from './studio/history.mjs';
import { openContextMenu, closeContextMenu, contextMenuOpen } from './studio/menu.mjs';
import { initTooltips } from './studio/tooltip.mjs';
import { attachPill } from './studio/pill.mjs';

const $ = id => document.getElementById(id);
const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v); else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};
const icon = name => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', `#i-${name}`); s.append(u); s.setAttribute('aria-hidden', 'true'); return s; };
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const isMac = /Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent);
const fmtNum = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString(getLang() === 'en' ? 'en-US' : 'ja-JP', { maximumFractionDigits: d }) : '—');

const state = {
  token: '', files: [], rootConfigured: false, ai: null, pens: null, generator: false,
  doc: null, selection: new Set(), hidden: new Set(), proposal: null, busy: false, lastInstruction: '', provider: store.get('fresco-studio-provider', 'auto'),
  tab: 'selection', fileFilter: '', openingId: null, details: null, checkLayer: null,
  // wave 2
  progress: null, focus: false, history: [], layerSort: store.get('fresco-studio-layer-sort', 'id'), odo: new Map()
};
let minimap = null, history = null, morph = null; // created after the canvas view (they read it)
const toast = createToaster($('toaster'));
const app = $('app'), stage = $('stage');

// ---- theme / language / motion -------------------------------------------------------------------------------------
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const theme = store.get('fresco-studio-theme', 'system');
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('sys-dark', theme === 'system' && darkQuery.matches);
  const dark = theme === 'dark' || (theme === 'system' && darkQuery.matches);
  const cs = getComputedStyle(document.documentElement);
  view.accent = cs.getPropertyValue('--accent').trim() || '#0a6cdf';
  view.colors = { add: cs.getPropertyValue('--green').trim(), remove: cs.getPropertyValue('--red').trim(), windowFill: dark ? 'rgba(59,147,255,.12)' : 'rgba(10,108,223,.08)', crossFill: dark ? 'rgba(50,215,75,.10)' : 'rgba(31,157,76,.08)' };
  view.setPens(state.pens, dark);
}
darkQuery.addEventListener('change', applyTheme);
function applyLang() {
  setLang(store.get('fresco-studio-locale', 'ja'));
  document.documentElement.lang = getLang() === 'en' ? 'en' : 'ja';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  $('sidebar').setAttribute('aria-label', t('files')); $('inspector').setAttribute('aria-label', t('inspectorSelection'));
  $('file-search').placeholder = t('searchFiles');
  $('cmd-kbd').textContent = isMac ? '⌘K' : 'Ctrl K';
  $('canvas-overlay').setAttribute('aria-label', t('canvasLabel'));
  for (const b of document.querySelectorAll('.icon-btn')) { const vh = b.querySelector('.vh[data-i18n]'); if (vh) b.dataset.tip = t(vh.dataset.i18n); }
  $('layer-sort').setAttribute('aria-label', t('sortLabel'));
  renderAll();
}
function applyMotionPref() { const v = readStoredReducedMotion(); setReducedMotion(v); document.body.classList.toggle('reduce-motion', v); }

// ---- canvas ----------------------------------------------------------------------------------------------------------
const view = new DrawingView({
  base: $('canvas-base'), overlay: $('canvas-overlay'), host: stage,
  insets: () => ({ l: app.classList.contains('no-sidebar') ? 16 : 296, t: 68, r: app.classList.contains('no-inspector') ? 16 : 328, b: Math.max(92, innerHeight - $('dock').getBoundingClientRect().top + 16) }),
  onSelect: (indices, mode) => select(indices, mode),
  onCamera: cam => { $('zoom-readout').textContent = `${fmtNum(cam.z / 3.7795 * 100)}%`; $('zoom-readout').dataset.tip = t('zoomLabel', { z: fmtNum(cam.z / 3.7795 * 100) }); minimap?.update(); },
  onPointer: p => updateCursor(p),
  canMove: () => !!state.doc && !state.busy && !state.proposal && !history?.previewing,
  onMoveDrag: info => updateDragChip(info),
  onMoveCommit: ({ ids, dx, dy }) => commitDragMove(ids, dx, dy),
  onContext: (x, y) => openCanvasMenu(x, y, false)
});
view.compares = [{ canvas: $('canvas-compare-a') }, { canvas: $('canvas-compare-b') }];
function updateCursor(p) {
  if (!p || !state.doc) { $('hud-cursor').textContent = ''; return; }
  // paper → model: use the scale of the dominant layer group (the HUD is a guide; the inspector shows exact values)
  const k = state.doc.mainScale || 1;
  $('hud-cursor').textContent = t('cursor', { x: fmtNum(p[0] * k), y: fmtNum(p[1] * k) });
}

// ---- api ------------------------------------------------------------------------------------------------------------
async function api(route, data) {
  const res = await fetch(`/api/${route}`, data === undefined ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fresco-Token': state.token }, body: JSON.stringify(data) });
  const body = await res.json().catch(() => ({ error: 'E_STUDIO_OPERATION' }));
  if (!res.ok) throw Object.assign(new Error(body.error), { code: body.error, detail: body.detail });
  return body;
}
const errorText = (code, detail) => { const s = t(`errors.${code}`, { detail: detail ?? '' }); return s.startsWith('errors.') ? `${t('errors.default')} (${code})` : s; };

// ---- files --------------------------------------------------------------------------------------------------------------
function renderFiles() {
  const list = $('file-list'), q = state.fileFilter.trim().toLowerCase();
  list.replaceChildren();
  if (!state.rootConfigured && !state.files.length) { list.append(h('p', { class: 'empty-list', text: `${t('noRoot')}\n${t('noRootBody')}` })); return; }
  const files = state.files.filter(f => !q || f.name.toLowerCase().includes(q));
  if (!files.length) { list.append(h('p', { class: 'empty-list', text: t('noFiles') })); return; }
  const groups = [[t('sourceFiles'), files.filter(f => !f.working)], [t('workFiles'), files.filter(f => f.working).sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))]];
  let i = 0;
  for (const [label, items] of groups) {
    if (!items.length) continue;
    list.append(h('div', { class: 'list-label' }, icon('folder'), label));
    for (const f of items) {
      const base = p => String(p ?? '').split(/[\/]/u).pop(), current = state.doc ? (state.doc.savedPath ? f.working && base(state.doc.savedPath) === f.name : state.doc.fileId === f.id) : false;
      const row = h('button', { class: `file-row${state.openingId === f.id ? ' busy' : ''}`, type: 'button', role: 'listitem', 'aria-current': current ? 'true' : 'false', title: f.name,
        onclick: () => openFile(f) }, icon('doc'), h('span', { class: 'name', text: f.name.replace(/[\\/]/gu, ' / ') }), f.size ? h('span', { class: 'meta', text: `${fmtNum(f.size / 1024)} KB` }) : null);
      if (!list.dataset.entered && i < 14) { row.classList.add('stagger'); row.style.animationDelay = `${i * 28}ms`; }
      i++; list.append(row);
    }
  }
  list.dataset.entered = '1';
}
async function refreshFiles() { const r = await api('v2/files'); state.files = r.files; renderFiles(); }

async function openFile(f) {
  if (state.busy || state.openingId) return;
  state.openingId = f.id; renderFiles(); $('loading').hidden = false; showSkeletons();
  try {
    const r = await api('v2/open', { fileId: f.id });
    if (state.doc) api('v2/close', { sessionId: state.doc.sessionId }).catch(() => {});
    receiveDoc(r, { fileId: f.id });
    toast.success(t('opened', { name: r.name }), { description: `${fmtNum(r.scene.ents.length)} ${getLang() === 'en' ? 'entities' : '要素'}` });
  } catch (e) { toast.error(t('openFailed'), { description: errorText(e.code) }); renderLayers(); renderInspector(); }
  finally { state.openingId = null; $('loading').hidden = true; renderFiles(); }
}
/** Skeleton shimmer while a drawing opens: the layer list and inspector keep their shape instead of blanking. */
function showSkeletons() {
  const row = w => h('div', { class: 'skel-row' }, h('span', { class: 'skel sq' }), h('span', { class: 'skel', style: null, dataset: { w } }), h('span', { class: 'skel sm' }));
  $('layer-list').replaceChildren(...['72', '54', '86', '60', '78', '48', '66', '58'].map(row));
  if (state.tab === 'selection') $('insp-selection').replaceChildren(h('div', { class: 'skel-block' }, h('span', { class: 'skel title' }), h('span', { class: 'skel', dataset: { w: '80' } }), h('span', { class: 'skel', dataset: { w: '64' } }), h('span', { class: 'skel', dataset: { w: '72' } })));
}
function receiveDoc(r, { fileId = state.doc?.fileId, keepCamera = false, keepSelectionIds = null } = {}) {
  const scene = r.scene, counts = new Map();
  for (const e of scene.ents) counts.set(scene.layers[e.l]?.scale ?? 1, (counts.get(scene.layers[e.l]?.scale ?? 1) ?? 0) + 1);
  const mainScale = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1;
  const firstOpen = !state.doc || state.doc.sessionId !== r.sessionId;
  state.doc = { ...r, fileId, mainScale, idIndex: new Map(scene.ents.map((e, i) => [e.id, i])) };
  if (firstOpen) { state.hidden = new Set(scene.layers.map((l, i) => (l.state === 0 && l.count ? i : -1)).filter(i => i >= 0)); state.history = []; state.odo.clear(); }
  clearProposal({ silent: true });
  endHistoryPreview();
  view.setScene(scene, { keepCamera });
  view.setHiddenLayers(state.hidden);
  if (state.focus && !keepSelectionIds?.length) setFocus(false);
  minimap.setScene(scene);
  history.set(state.history);
  const sel = keepSelectionIds ? keepSelectionIds.map(id => state.doc.idIndex.get(id)).filter(i => i !== undefined) : [];
  select(sel, 'replace', { quiet: true });
  $('empty').hidden = true; $('canvas-tools').hidden = false; $('hud').hidden = false;
  $('doc-name').textContent = r.name;
  const chip = $('doc-chip'); chip.hidden = !r.savedPath; chip.textContent = r.savedPath ? (getLang() === 'en' ? 'Saved copy' : '保存済みコピー') : '';
  $('hud-scale').textContent = `1:${fmtNum(mainScale)}`;
  renderLayers(); renderInspector(); renderCommand(); renderCheck();
}

// ---- layers ---------------------------------------------------------------------------------------------------------------
function renderLayers({ flip = false, ripple = null } = {}) {
  const list = $('layer-list');
  // FLIP: remember where each row was, so a re-sort glides rows to their new places (transform only)
  const before = flip && !prefersReducedMotion() ? new Map([...list.querySelectorAll('.layer-row')].map(r => [r.dataset.i, r.getBoundingClientRect().top])) : null;
  list.replaceChildren();
  const scene = state.doc?.scene;
  $('layer-sort').hidden = !scene;
  if (!scene) { $('layers-all').hidden = true; return; }
  $('layers-all').hidden = !state.hidden.size;
  const byGroup = new Map();
  scene.layers.forEach((l, i) => { if (!l.count) return; const g = l.id.split(':')[0]; (byGroup.get(g) ?? byGroup.set(g, []).get(g)).push([l, i]); });
  if (state.layerSort === 'count') for (const rows of byGroup.values()) rows.sort((a, b) => b[0].count - a[0].count);
  let n = 0;
  for (const [g, rows] of byGroup) {
    const first = rows[0][0];
    list.append(h('div', { class: 'group-head' }, h('b', { text: `${t('group')} ${g}` }), first.groupName ? first.groupName : '', `· 1:${fmtNum(first.scale)}`));
    for (const [l, i] of rows) {
      const on = !state.hidden.has(i);
      const box = h('button', { class: 'check', type: 'button', role: 'checkbox', 'aria-checked': String(on), 'aria-label': `${l.id} ${l.name || ''}`, 'data-tip': t('soloHint'),
        onclick: e => toggleLayer(i, e.altKey, box) }, h('span', { class: 'box' }, icon('check')));
      const solo = h('button', { class: 'solo-btn', type: 'button', 'aria-label': `${t('soloBtn')} ${l.id}`, 'data-tip': t('soloBtn'), onclick: () => toggleLayer(i, true, box) }, 'S');
      const role = l.roleJa ? `${l.roleJa}${l.roleSource === 'profile' ? ` · ${t('roleFromProfile')}` : ''}` : l.ruleJa ? `${l.ruleJa} · ${t('ruleLayer')}` : '';
      const c = l.check, badge = c && (c.error || c.warning) ? h('button', { class: `badge ${c.error ? 'error' : 'warning'}`, type: 'button', title: t('checkSummary', { e: c.error ?? 0, w: c.warning ?? 0, i: c.info ?? 0 }),
        onclick: () => { state.checkLayer = l.id; setTab('check'); } }, String((c.error ?? 0) + (c.warning ?? 0))) : null;
      const row = h('div', { class: `layer-row${on ? '' : ' off'}`, dataset: { i: String(i) } }, box,
        h('div', { class: 'l-main' }, h('span', { class: 'l-name' }, h('span', { class: 'lid', text: l.id }), l.name || t('unnamed')), role ? h('span', { class: 'l-role', text: role }) : null),
        h('div', { class: 'l-side' }, solo, badge, h('span', { class: 'l-count', text: fmtNum(l.count) })));
      if (!list.dataset.entered && n < 14) { row.classList.add('stagger'); row.style.animationDelay = `${n * 24}ms`; }
      n++; list.append(row);
    }
  }
  list.dataset.entered = '1';
  if (before) for (const row of list.querySelectorAll('.layer-row')) {
    const was = before.get(row.dataset.i); if (was === undefined) continue;
    const dy = was - row.getBoundingClientRect().top; if (Math.abs(dy) < 1) continue;
    row.__motion = undefined; animate(row, { y: dy }, { immediate: true }); animate(row, { y: 0 }, { damping: 0.9, response: 0.36 });
  }
  if (ripple !== null && !prefersReducedMotion()) {
    // solo: the change spreads outward from the row you clicked (12 ms per row, capped) — cause → effect
    const rows = [...list.querySelectorAll('.layer-row')], at = rows.findIndex(r => r.dataset.i === String(ripple));
    rows.forEach((r, k) => {
      const b = r.querySelector('.box'); b.__motion = undefined;
      const delay = Math.min(220, Math.abs(k - at) * 12);
      animate(b, { scale: k === at ? 0.8 : 0.9 }, { immediate: true });
      setTimeout(() => animate(b, { scale: 1 }, SPRINGS.check), delay);
    });
  }
}
function setLayerSort(mode, { keyboard = false } = {}) {
  if (state.layerSort === mode) return;
  state.layerSort = mode; store.set('fresco-studio-layer-sort', mode);
  for (const b of $('layer-sort').querySelectorAll('[role=radio]')) b.setAttribute('aria-checked', String(b.dataset.sort === mode));
  $('layer-sort').__pill?.sync({ instant: keyboard });
  renderLayers({ flip: !keyboard });
}
function toggleLayer(i, solo, box) {
  const used = state.doc.scene.layers.map((l, k) => (l.count ? k : -1)).filter(k => k >= 0);
  if (solo) state.hidden = new Set(used.filter(k => k !== i));
  else if (state.hidden.has(i)) state.hidden.delete(i); else state.hidden.add(i);
  view.setHiddenLayers(state.hidden); minimap.redraw();
  const on = !state.hidden.has(i);
  if (solo) renderLayers({ ripple: i });
  else {
    box.setAttribute('aria-checked', String(on)); box.closest('.layer-row').classList.toggle('off', !on); $('layers-all').hidden = !state.hidden.size;
    // springy checkmark: the tick lands with a little life; unticking is quick and quiet
    const svg = box.querySelector('svg');
    if (on && !prefersReducedMotion()) { svg.__motion = undefined; animate(svg, { scale: 0.4 }, { immediate: true }); animate(svg, { scale: 1 }, SPRINGS.check); }
    const b = box.querySelector('.box'); b.__motion = undefined; if (!prefersReducedMotion()) { animate(b, { scale: 0.86 }, { immediate: true }); animate(b, { scale: 1 }, SPRINGS.check); }
  }
}
$('layers-all').addEventListener('click', () => { state.hidden.clear(); view.setHiddenLayers(state.hidden); minimap.redraw(); renderLayers(); });
$('layer-sort').addEventListener('click', e => { const b = e.target.closest('[data-sort]'); if (b) setLayerSort(b.dataset.sort, { keyboard: e.detail === 0 }); });

// ---- selection & inspector -------------------------------------------------------------------------------------------
function select(indices, mode = 'replace', { quiet = false } = {}) {
  let next = mode === 'replace' ? new Set() : new Set(state.selection);
  for (const i of indices) { if (mode === 'toggle' && next.has(i)) next.delete(i); else next.add(i); }
  if (next.size > 500) next = new Set([...next].slice(0, 500));
  state.selection = next; view.setSelection(next);
  if (state.focus && !next.size) setFocus(false);
  state.details = null;
  if (!quiet) $('live').textContent = t('selectionAnnounce', { n: next.size });
  if (state.tab !== 'selection' && next.size && !quiet) setTab('selection');
  renderInspector(); renderCommand();
  if (next.size === 1) loadDetails([...next][0]);
}
async function loadDetails(i) {
  const doc = state.doc, id = doc.scene.ents[i].id;
  try { const d = await api(`v2/entity?session=${encodeURIComponent(doc.sessionId)}&id=${encodeURIComponent(id)}`); if (state.selection.size === 1 && state.selection.has(i) && state.doc === doc) { state.details = d; renderInspector(); } }
  catch {}
}
function setTab(tab, { keyboard = false } = {}) {
  const changed = state.tab !== tab;
  state.tab = tab;
  for (const b of $('insp-tabs').querySelectorAll('[role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  if (changed) $('insp-tabs').__pill?.sync({ instant: keyboard });
  $('insp-selection').hidden = tab !== 'selection'; $('insp-check').hidden = tab !== 'check';
  if (tab === 'check') renderCheck();
}
$('insp-tabs').addEventListener('click', e => { const b = e.target.closest('[role=tab]'); if (b) { if (b.dataset.tab === 'check') state.checkLayer = null; setTab(b.dataset.tab, { keyboard: e.detail === 0 }); } });
$('insp-tabs').addEventListener('keydown', e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { const next = state.tab === 'selection' ? 'check' : 'selection'; setTab(next, { keyboard: true }); $(`tab-${next}`).focus(); } });

const layerOptions = (current) => {
  const sel = h('select', { class: 'select', 'aria-label': t('layer') });
  state.doc.scene.layers.forEach(l => { if (l.count || l.name || l.id === current) sel.append(h('option', { value: l.id, text: `${l.id}  ${l.name || l.roleJa || ''}`.trim(), selected: l.id === current })); });
  return sel;
};
const numInput = (value, axis, onCommit, label, scrub = {}) => {
  const input = h('input', { class: 'input', type: 'number', step: 'any', value: Number.isFinite(value) ? String(value) : '', 'aria-label': label });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); onCommit(); } });
  if (!axis) return input;
  const handle = h('span', { class: 'axis-handle', text: axis, 'data-tip': t('scrubHint') });
  scrubbable(handle, input, { perPx: 1, decimals: 1, ...scrub });
  return h('label', { class: 'axis' }, handle, input);
};
/** A read-only number that rolls (odometer) when it changes from elsewhere — keyed so re-renders know the old text. */
const odoDd = (key, text) => {
  const dd = h('dd', { text }), prev = state.odo.get(key); state.odo.set(key, text);
  if (prev !== undefined && prev !== text) queueMicrotask(() => setOdometer(dd, text, { animateFrom: prev }));
  return dd;
};
/** Scrub a plain field by its label (radius, text height). */
const scrubLabel = (labelText, input, opts) => { const s = h('span', { text: labelText, 'data-tip': t('scrubHint') }); scrubbable(s, input, opts); return s; };
function renderInspector() {
  const body = $('insp-selection'); body.replaceChildren();
  const doc = state.doc;
  if (!doc) { body.append(h('div', { class: 'empty-insp' }, h('h3', { text: t('inspectorSelection') }), h('p', { class: 'note', text: t('inspectorEmpty') }))); return; }
  const scene = doc.scene, sel = [...state.selection];
  if (!sel.length) {
    const used = scene.layers.filter(l => l.count).length, b = scene.bbox;
    const s = scene.check?.summary;
    body.append(h('div', { class: 'insp-head' }, h('span', { class: 'kind-icon' }, icon('doc')), h('h3', { text: doc.name })));
    body.append(h('dl', { class: 'kv' }, h('dt', { text: t('entityCount') }), odoDd('ents', fmtNum(scene.ents.length)), h('dt', { text: t('layerCount') }), odoDd('layers', fmtNum(used)),
      h('dt', { text: t('scale') }), h('dd', { text: `1:${fmtNum(doc.mainScale)}` }), b ? h('dt', { text: t('paper') }) : null, b ? h('dd', { text: `${fmtNum(b[2] - b[0])} × ${fmtNum(b[3] - b[1])} mm` }) : null,
      s ? h('dt', { text: t('inspectorCheck') }) : null, s ? h('dd', { text: t('checkSummary', { e: s.error, w: s.warning, i: s.info }) }) : null));
    body.append(h('div', { class: 'empty-insp' }, h('h3', { text: t('nothingSelected') }), h('p', { class: 'note', text: t('nothingSelectedBody') })));
    return;
  }
  const ents = sel.map(i => scene.ents[i]);
  if (sel.length === 1) {
    const e = ents[0], d = state.details, kindName = t(`kind.${e.k}`);
    body.append(h('div', { class: 'insp-head' }, h('span', { class: 'kind-icon', text: kindName.slice(0, 1) }), h('h3', { text: kindName }), h('span', { class: 'eid', text: e.id })));
    const layerSel = layerOptions(scene.layers[e.l].id);
    layerSel.addEventListener('change', () => manualPatch([{ op: 'setLayer', ids: [e.id], layer: layerSel.value }]));
    body.append(h('div', { class: 'group' }, h('h4', { text: t('layer') }), layerSel));
    if (['line', 'arc', 'point', 'text', 'solid'].includes(e.k)) body.append(penGroup(ents));
    if (!d) { body.append(h('p', { class: 'note', text: t('loading') })); return; }
    const geo = h('div', { class: 'group' }, h('h4', { text: t('geometry') }));
    const pointRow = (label, key) => {
      const [x, y] = d[key]; const ix = numInput(x, 'X', () => commit(), `${label} X`), iy = numInput(y, 'Y', () => commit(), `${label} Y`);
      const commit = () => { const v = [Number(ix.querySelector('input').value), Number(iy.querySelector('input').value)]; if (v.every(Number.isFinite)) modify(e.id, { [key]: v }); };
      geo.append(h('div', { class: 'field' }, h('span', { text: label }), h('div', { class: 'pair' }, ix, iy)));
    };
    if (d.start && d.editable.includes('start')) pointRow(t('start'), 'start');
    if (d.end && d.editable.includes('end')) pointRow(t('end'), 'end');
    if (d.center) pointRow(t('center'), 'center');
    if (d.at && d.editable.includes('at')) pointRow(t('at'), 'at');
    if (Number.isFinite(d.radius)) { const r = numInput(d.radius, null, () => { const v = Number(r.value); if (v > 0) modify(e.id, { radius: v }); }, t('radius')); geo.append(h('div', { class: 'field' }, scrubLabel(t('radius'), r, { perPx: 1, min: 0.1, decimals: 1 }), r)); }
    if (d.kind === 'text') {
      const tx = h('input', { class: 'input', type: 'text', value: d.text ?? '', 'aria-label': t('text') });
      tx.addEventListener('keydown', ev => { if (ev.key === 'Enter' && tx.value.trim()) modify(e.id, { text: tx.value }); });
      const ht = numInput(d.height, null, () => { const v = Number(ht.value); if (v > 0) modify(e.id, { height: v }); }, t('height'));
      geo.append(h('div', { class: 'field' }, h('span', { text: t('text') }), tx), h('div', { class: 'field' }, scrubLabel(t('height'), ht, { perPx: 0.05, min: 0.5, max: 100, decimals: 2 }), ht));
    }
    if (Number.isFinite(d.length)) geo.append(h('dl', { class: 'kv' }, h('dt', { text: t('length') }), odoDd(`len:${e.id}`, `${fmtNum(d.length, 1)} mm`)));
    if (d.kind === 'block') geo.append(h('dl', { class: 'kv' }, h('dt', { text: t('blockName') }), h('dd', { text: d.name ?? `#${d.number}` }), h('dt', { text: t('at') }), h('dd', { text: d.at.map(v => fmtNum(v)).join(', ') })));
    if (!d.editable.length) geo.append(h('p', { class: 'note', text: t('readOnly') }));
    else geo.append(h('p', { class: 'note', text: t('editHint') }));
    body.append(geo);
  } else {
    const kinds = new Map(); for (const e of ents) kinds.set(e.k, (kinds.get(e.k) ?? 0) + 1);
    body.append(h('div', { class: 'insp-head' }, h('span', { class: 'kind-icon', text: String(sel.length) }), h('h3', { text: t('selected', { n: sel.length }) })));
    body.append(h('div', { class: 'chips' }, [...kinds].map(([k, n]) => h('span', { class: 'chip', text: `${t(`kind.${k}`)} ${n}` }))));
    const layers = new Set(ents.map(e => scene.layers[e.l].id)), layerSel = layerOptions(layers.size === 1 ? [...layers][0] : '');
    if (layers.size > 1) layerSel.prepend(h('option', { value: '', text: '—', selected: true }));
    layerSel.addEventListener('change', () => layerSel.value && manualPatch([{ op: 'setLayer', ids: ents.map(e => e.id), layer: layerSel.value }]));
    body.append(h('div', { class: 'group' }, h('h4', { text: t('layer') }), layerSel), penGroup(ents));
  }
  // move + delete apply to any selection
  const ix = numInput(0, 'X', () => go(), 'dX'), iy = numInput(0, 'Y', () => go(), 'dY');
  const go = () => { const dx = Number(ix.querySelector('input').value), dy = Number(iy.querySelector('input').value); if ((dx || dy) && Number.isFinite(dx) && Number.isFinite(dy)) manualPatch([{ op: 'translate', ids: ents.map(e => e.id), dx, dy }]); };
  body.append(h('div', { class: 'group' }, h('h4', { text: t('moveBy') }), h('div', { class: 'pair' }, ix, iy),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn small danger', type: 'button', text: t('delete'), onclick: () => manualPatch([{ op: 'delete', ids: ents.map(e => e.id) }]) }),
      h('button', { class: 'btn small', type: 'button', text: t('move'), onclick: go }))));
}
function penGroup(ents) {
  const pal = view.palette, cur = new Set(ents.map(e => e.c)), sw = h('div', { class: 'swatches', role: 'group', 'aria-label': t('pen') });
  for (let c = 1; c <= 9; c++) {
    const b = h('button', { class: 'swatch', type: 'button', 'aria-pressed': String(cur.size === 1 && cur.has(c)), 'aria-label': `${t('pen')} ${c}`, title: `${t('pen')} ${c}`,
      onclick: () => manualPatch([{ op: 'setPen', ids: ents.filter(e => e.k !== 'block' && e.k !== 'dimension').map(e => e.id), pen: { color: c, style: null, width: null } }]) });
    b.style.background = pal.rgb[c]; sw.append(b);
  }
  return h('div', { class: 'group' }, h('h4', { text: t('pen') }), sw);
}
const modify = (id, set) => manualPatch([{ op: 'modify', id, set: { start: null, end: null, at: null, center: null, radius: null, startAngle: null, sweepAngle: null, text: null, height: null, width: null, angle: null, ...set } }]);

// ---- layer check -----------------------------------------------------------------------------------------------------------
function renderCheck() {
  const body = $('insp-check'), check = state.doc?.scene.check; body.replaceChildren();
  const s = check?.summary, n = s ? s.error + s.warning : 0, badge = $('check-count');
  badge.hidden = !n; badge.textContent = n > 99 ? '99+' : String(n);
  if (!state.doc) return;
  if (!check) { body.append(h('p', { class: 'note', text: t('checkUnavailable') })); return; }
  body.append(h('p', { class: 'note', text: t('checkSummary', { e: s.error, w: s.warning, i: s.info }) }));
  const items = check.findings.filter(f => !state.checkLayer || f.layerId === state.checkLayer);
  if (state.checkLayer) body.append(h('div', { class: 'chips' }, h('span', { class: 'chip', text: `${t('layer')} ${state.checkLayer}` }), h('button', { class: 'text-btn', type: 'button', text: t('showAll'), onclick: () => { state.checkLayer = null; renderCheck(); } })));
  if (!items.length) { body.append(h('p', { class: 'note', text: t('checkNone') })); return; }
  const list = h('div', { class: 'group' });
  for (const f of items.slice(0, 200)) {
    list.append(h('button', { class: 'finding', type: 'button', title: t('showEntities'), onclick: () => {
      const idx = f.entityIds.map(id => state.doc.idIndex.get(id)).filter(i => i !== undefined);
      select(idx, 'replace', { quiet: true }); view.fitSelection(); $('live').textContent = t('selectionAnnounce', { n: idx.length });
    } }, h('span', { class: `sev ${f.severity}` }), h('span', {}, getLang() === 'en' ? `${f.ruleId}: ${f.ja}` : f.ja, h('small', { text: `${t(`severity.${f.severity}`)} · ${f.layerId} · ${f.count}` }))));
  }
  body.append(list);
}

// ---- command bar -------------------------------------------------------------------------------------------------------
const providers = () => {
  const k = state.ai?.keys ?? {};
  return [['auto', t('providerAuto'), true], ['mock', t('providerMock'), true], ['claude', t('providerClaude'), k.claude], ['claude-fast', t('providerClaudeFast'), k.claude], ['openai', t('providerOpenAI'), k.openai]];
};
const effectiveProvider = () => {
  const k = state.ai?.keys ?? {}, def = state.ai?.provider ?? 'claude', fam = p => (p === 'openai' ? 'openai' : 'claude');
  if (state.provider === 'auto') return k[fam(def)] ? def : 'mock';
  return state.provider;
};
function renderCommand() {
  const ready = !!state.doc, input = $('command'), eff = effectiveProvider();
  input.disabled = !ready || state.busy; input.placeholder = ready ? t('commandPlaceholder') : t('commandDisabled');
  $('commandbar').classList.toggle('disabled', !ready);
  $('send').disabled = !ready || state.busy || !input.value.trim();
  const p = providers().find(x => x[0] === state.provider) ?? providers()[0];
  const noKey = eff !== 'mock' && !(state.ai?.keys ?? {})[eff === 'openai' ? 'openai' : 'claude'];
  $('provider-label').textContent = state.provider === 'auto' ? `${t('providerAuto')} · ${eff === 'mock' ? t('providerMock') : providers().find(x => x[0] === eff)?.[1]}` : p[1];
  $('provider-dot').className = `dot ${eff === 'mock' ? 'demo' : noKey ? '' : 'ok'}`;
  const n = state.selection.size, chip = $('sel-chip'); chip.hidden = !n || !ready; chip.textContent = t('selectionChip', { n });
  const keys = state.ai?.keys ?? {};
  $('key-notice').hidden = !(state.ai && !keys.claude && !keys.openai) || store.get('fresco-studio-notice') === 'off' || !!state.proposal;
}
$('command').addEventListener('input', renderCommand);
$('commandbar').addEventListener('submit', e => { e.preventDefault(); const v = $('command').value.trim(); if (v) runEdit(v); });
$('notice-dismiss').addEventListener('click', () => { store.set('fresco-studio-notice', 'off'); renderCommand(); });
$('provider-btn').addEventListener('click', e => openProviderMenu(e.detail === 0));
function openProviderMenu(keyboard) {
  const menu = $('provider-menu');
  if (isOpen(menu)) { hideSheet(menu); return; }
  menu.replaceChildren(...providers().map(([id, label, ok]) => h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(state.provider === id), disabled: !ok,
    onclick: () => { state.provider = id; store.set('fresco-studio-provider', id); hideSheet(menu); renderCommand(); } }, label, !ok ? h('span', { class: 'hint', text: t('keyMissing') }) : null)));
  $('provider-btn').setAttribute('aria-expanded', 'true');
  showSheet(menu, $('provider-btn'), { keyboard, onClose: () => $('provider-btn').setAttribute('aria-expanded', 'false') });
}
$('provider-menu').addEventListener('keydown', e => {
  const items = [...$('provider-menu').querySelectorAll('button:not(:disabled)')], i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
});

let workTimer = 0, workT0 = 0;
function setBusy(busy, mock) {
  state.busy = busy; $('commandbar').classList.toggle('working', busy);
  clearInterval(workTimer);
  if (busy) {
    workT0 = performance.now(); const label = mock ? t('workingMock') : t('working');
    const tick = () => {
      const s = t('elapsed', { s: Math.floor((performance.now() - workT0) / 1000) });
      $('work-status').textContent = `${label} ${s}`;
      const el = document.getElementById('p-elapsed'); if (el) el.textContent = s;
    };
    tick(); workTimer = setInterval(tick, 1000);
  } else $('work-status').textContent = '';
  renderCommand();
}

// ---- live progress timeline (streamed from /api/v2/edit-stream) -----------------------------------------------------------
// Events are applied in order with a 45 ms stagger so a burst (the mock answers instantly) still reads as a sequence;
// a slow step (reading a 21k-entity drawing) simply stays "running" for as long as it really takes.
let progQ = [], progTimer = 0, progWaiters = [];
function pushProgress(ev) { progQ.push(ev); if (!progTimer) drainProgress(); }
function drainProgress() {
  const ev = progQ.shift();
  if (!ev) { progTimer = 0; for (const r of progWaiters.splice(0)) r(); return; }
  state.progress = reduceProgress(state.progress ?? emptyProgress(), ev);
  renderTimeline(document.getElementById('p-timeline'), { animateIn: true });
  progTimer = setTimeout(drainProgress, prefersReducedMotion() ? 0 : 45);
}
const progressDrained = () => (progTimer || progQ.length ? new Promise(r => progWaiters.push(r)) : Promise.resolve());
const STEP_ICON = { run: '', ok: 'check', fail: 'x', ask: 'help' };
function stepMeta(s) {
  if (s.id === 'load' && s.info) return t('stepLoadInfo', { e: fmtNum(s.info.entities), l: fmtNum(s.info.layers) });
  if (s.id === 'search') { const last = s.tools.at(-1); return s.count ? `${t('stepTools', { n: s.count })}${last ? ` · ${last.name}${last.detail ? ` ${last.detail}` : ''}` : ''}` : ''; }
  if (s.id === 'propose' && s.info) return `${t('stepOps', { n: s.info.ops })}${s.info.kinds?.length ? ` · ${s.info.kinds.join(', ')}` : ''}`;
  return '';
}
function renderTimeline(ol, { animateIn = false } = {}) {
  if (!ol || !state.progress) return;
  const p = state.progress, reduced = prefersReducedMotion();
  let grew = false;
  for (const s of p.steps) {
    let li = ol.querySelector(`[data-key="${s.key}"]`);
    const label = s.id === 'retry' ? `${t('step.retry')} — ${t('stepAttempt', { n: s.attempt + 1 })}` : s.id === 'done' ? t(p.status === 'applied' ? 'step.done' : p.status === 'clarification' ? 'step.ask' : 'step.failed')
      : `${t(`step.${s.id}`)}${s.attempt > 1 && s.id === 'search' ? ` · ${t('stepAttempt', { n: s.attempt })}` : ''}`;
    if (!li) {
      li = h('li', { class: `tl-step tl-${s.id}`, dataset: { key: s.key } }, h('span', { class: 'tl-dot' }), h('div', { class: 'tl-body' }, h('span', { class: 'tl-label' }), h('span', { class: 'tl-meta' })));
      ol.append(li); grew = true;
      if (animateIn) { li.__motion = undefined; animate(li, reduced ? { opacity: 0 } : { opacity: 0, y: 8 }, { immediate: true }); animate(li, { opacity: 1, y: 0 }, { damping: 0.9, response: 0.3 }); }
    }
    li.querySelector('.tl-label').textContent = label;
    li.querySelector('.tl-meta').textContent = stepMeta(s);
    if (li.dataset.state !== s.state) {
      const dot = li.querySelector('.tl-dot'), had = li.dataset.state;
      li.dataset.state = s.state; dot.replaceChildren(...(STEP_ICON[s.state] ? [icon(STEP_ICON[s.state])] : []));
      if (had && s.state !== 'run' && animateIn && !reduced) { dot.__motion = undefined; animate(dot, { scale: 0.5 }, { immediate: true }); animate(dot, { scale: 1 }, SPRINGS.check); }
    }
    const err = s.error;
    let box = li.querySelector('.tl-error');
    if (err && !box) { box = h('div', { class: 'tl-error' }); li.querySelector('.tl-body').append(box); grew = true; }
    if (box && err) box.textContent = `${err.code} — ${errorText(err.code, err.detail)}${err.detail && s.id === 'retry' ? `\n${err.detail}` : ''}`;
  }
  if (grew) morph?.resize();
}
function startProgress(title, mock) {
  state.progress = emptyProgress(); progQ = []; clearTimeout(progTimer); progTimer = 0;
  const content = $('proposal-content');
  content.replaceChildren(
    h('div', { class: 'p-head' }, h('span', { class: 'p-icon work' }, h('span', { class: 'toast-spinner' })), h('h3', { text: t('progressTitle') }),
      h('div', { class: 'p-meta' }, h('span', { text: mock ? t('providerMock') : providers().find(x => x[0] === effectiveProvider())?.[1] ?? '' }), h('span', { id: 'p-elapsed', text: '' }))),
    h('p', { class: 'p-instruction', text: title }),
    h('ol', { class: 'timeline', id: 'p-timeline', 'aria-live': 'polite' }));
  openCard();
}
function openCard() { if (morph.open) morph.resize(); else morph.show(); $('proposal').classList.add('is-open'); }

async function runEdit(instruction, { provider } = {}) {
  if (!state.doc || state.busy) return;
  state.lastInstruction = instruction;
  const chosen = provider ?? state.provider, mock = (provider ?? effectiveProvider()) === 'mock';
  clearProposal({ silent: true, keepCard: true }); setBusy(true, mock);
  startProgress(instruction, mock);
  let result = null;
  const body = { sessionId: state.doc.sessionId, baseHash: state.doc.hash, instruction, provider: chosen, selection: [...state.selection].map(i => state.doc.scene.ents[i].id) };
  try {
    const res = await fetch('/api/v2/edit-stream', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fresco-Token': state.token }, body: JSON.stringify(body) });
    if (!res.ok || !res.body) { const b = await res.json().catch(() => ({ error: 'E_STUDIO_OPERATION' })); throw Object.assign(new Error(b.error), { code: b.error }); }
    await readNdjson(res.body, ev => {
      if (ev.t === 'result') result = ev.result;
      if (ev.t === 'error') result = { status: 'failed', error: { code: ev.code, detail: ev.detail }, attempts: [] };
      pushProgress(ev);
    });
    if (!result) throw Object.assign(new Error('E_STUDIO_OPERATION'), { code: 'E_STUDIO_OPERATION' });
  } catch (e) {
    result = { status: 'failed', error: { code: e.code ?? 'E_STUDIO_OPERATION' }, attempts: [] };
    pushProgress({ t: 'error', code: result.error.code });
  }
  await progressDrained();
  setBusy(false);
  showProposal({ ...result, instruction });
  if (result.status === 'applied') $('command').value = '';
}
async function manualPatch(ops, { keepCamera = false } = {}) {
  if (!state.doc || state.busy) return false;
  setBusy(true, true);
  startProgress(t('manual'), true);
  pushProgress({ t: 'step', id: 'propose', state: 'ok', attempt: 1, info: { ops: ops.length, kinds: [...new Set(ops.map(o => o.op))] } });
  pushProgress({ t: 'step', id: 'l1', state: 'run', attempt: 1 });
  let r = null, ok = false;
  try {
    const patch = { schemaVersion: 2, sourceHash: state.doc.hash, units: 'model-mm', rationale: t('manual'), needsClarification: null, ops };
    r = { ...(await api('v2/patch', { sessionId: state.doc.sessionId, baseHash: state.doc.hash, patch })), manual: true, keepCamera };
    pushProgress({ t: 'step', id: 'l1', state: 'ok', attempt: 1 }); pushProgress({ t: 'step', id: 'l2', state: 'ok', attempt: 1 });
    pushProgress({ t: 'result', result: r }); ok = true;
  } catch (e) {
    r = { status: 'failed', manual: true, error: { code: e.code ?? 'E_STUDIO_OPERATION', detail: e.detail }, attempts: [] };
    pushProgress({ t: 'error', code: r.error.code, detail: e.detail });
  }
  await progressDrained();
  setBusy(false);
  showProposal(r);
  return ok;
}

// ---- proposal card (morphs out of the command bar) ---------------------------------------------------------------------
function stepsSummary() {
  const p = state.progress; if (!p?.steps.length) return null;
  const real = p.steps.filter(s => s.id !== 'done');
  const det = h('details', { class: 'p-steps' }, h('summary', {}, `${t('progressTitle')} · ${real.length}`, p.attempt > 1 ? ` · ${t('attempts', { n: p.attempt, max: p.max || state.ai?.maxAttempts || 3 })}` : ''),
    h('ol', { class: 'timeline' }));
  renderTimeline(det.querySelector('ol'));
  det.addEventListener('toggle', () => morph.resize());
  if (p.steps.some(s => s.id === 'retry')) det.open = true; // a retry is worth seeing without a click
  return det;
}
function showProposal(p) {
  state.proposal = p; const sheet = $('proposal-content'), lang = getLang();
  sheet.replaceChildren();
  view.clearMove();
  const meta = h('div', { class: 'p-meta' });
  if (p.attempts?.length) meta.append(h('span', { text: t('attempts', { n: p.attempts.length, max: state.ai?.maxAttempts ?? 3 }) }));
  if (p.provider && !p.manual) meta.append(h('span', { text: p.provider === 'mock' ? t('providerMock') : p.model ?? p.provider }));
  if (!p.manual && p.status !== 'failed' || p.costEstimate) meta.append(h('span', { text: p.demo || p.provider === 'mock' ? t('costMock') : Number.isFinite(p.costEstimate?.usd) ? t('cost', { usd: p.costEstimate.usd.toFixed(3) }) : t('cost0') }));
  if (Number.isFinite(p.latencyMs)) meta.append(h('span', { text: `${(p.latencyMs / 1000).toFixed(1)} s` }));
  const steps = stepsSummary();
  if (p.status === 'applied') {
    sheet.append(h('div', { class: 'p-head' }, h('span', { class: 'p-icon ok' }, icon('check')), h('h3', { text: p.manual ? t('manual') : t('proposal') }), meta));
    if (p.rationale && !p.manual) sheet.append(h('p', { class: 'p-rationale', text: p.rationale }));
    const ops = h('ul', { class: 'ops' });
    p.ops.forEach((op, i) => { const d = describeOp(op, lang); const li = h('li', { class: 'op' }, h('span', { class: `tag ${d.tone}`, text: op.op }), h('span', { class: 'label', text: d.label }), h('span', { class: 'detail', text: d.detail, title: d.detail })); if (i < 8) { li.classList.add('stagger'); li.style.animationDelay = `${60 + i * 40}ms`; } ops.append(li); });
    sheet.append(ops);
    const df = p.diff, moved = df.moves.length, legend = h('div', { class: 'legend' });
    if (df.removed.length - moved > 0) legend.append(h('span', { class: 'rm' }, h('i'), t('removed', { n: df.removed.length - moved })));
    if (df.added.ents.length - moved > 0) legend.append(h('span', { class: 'ad' }, h('i'), t('added', { n: df.added.ents.length - moved })));
    if (moved) legend.append(h('span', { class: 'mv' }, h('i'), t('moved', { n: moved })));
    legend.append(h('button', { class: 'text-btn', type: 'button', onclick: () => view.replayDiff() }, t('replay')));
    sheet.append(legend);
    const lc = p.layerCheck, warn = lc?.findings?.filter(f => f.severity !== 'info') ?? [];
    if (warn.length) {
      const box = h('div', { class: 'warn-box' }, h('strong', { text: t('layerWarnings') }), ...warn.slice(0, 4).map(f => h('div', { class: 'w' }, h('span', { class: `sev ${f.severity}` }), lang === 'en' ? `${f.ruleId}: ${f.ja}` : f.ja)));
      if (lc.corrections?.length) { const c = lc.corrections[0]; box.append(h('div', {}, h('button', { class: 'btn small', type: 'button', text: t('applySuggested', { to: `${c.to}${c.roleJa ? ` ${c.roleJa}` : ''}` }), onclick: fixLayers }))); }
      sheet.append(box);
    }
    if (steps) sheet.append(steps);
    sheet.append(h('div', { class: 'p-actions' }, h('span', { class: 'hint', text: isMac ? t('acceptHint') : t('acceptHint').replace('⌘↵', 'Ctrl+Enter') }),
      h('button', { class: 'btn', type: 'button', text: t('reject'), onclick: () => reject() }),
      h('button', { class: 'btn primary', type: 'button', id: 'accept-btn', onclick: () => accept() }, t('accept'))));
    stage.classList.add('diffing'); view.setDiff(p.diff);
    if (p.diff.bbox && !p.keepCamera) {
      // frame the change with context: about 60% of the drawing around it
      const b = p.diff.bbox, d = view.bbox ?? b, mw = (d[2] - d[0]) * 0.6, mh = (d[3] - d[1]) * 0.6, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
      const w = Math.max(b[2] - b[0], mw) / 2, hh = Math.max(b[3] - b[1], mh) / 2;
      requestAnimationFrame(() => view.fit([cx - w, cy - hh, cx + w, cy + hh], { padding: 48 }));
    }
  } else if (p.status === 'clarification') {
    sheet.append(h('div', { class: 'p-head' }, h('span', { class: 'p-icon ask' }, icon('help')), h('h3', { text: t('clarification') }), meta));
    sheet.append(h('p', { class: 'p-question', text: p.question }));
    const input = h('input', { class: 'input', type: 'text', placeholder: t('replyPlaceholder'), 'aria-label': t('replyPlaceholder') });
    const send = () => input.value.trim() && runEdit(`${p.instruction}\n（確認への回答: ${p.question} → ${input.value.trim()}）`);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    sheet.append(h('div', { class: 'reply' }, input, h('button', { class: 'btn primary', type: 'button', text: t('reply'), onclick: send })));
    if (steps) sheet.append(steps);
    sheet.append(h('div', { class: 'p-actions' }, h('span', { class: 'hint' }), h('button', { class: 'btn', type: 'button', text: t('dismiss'), onclick: () => clearProposal() })));
  } else {
    const code = p.error?.code ?? 'E_STUDIO_OPERATION';
    sheet.append(h('div', { class: 'p-head' }, h('span', { class: 'p-icon bad' }, icon('x')), h('h3', { text: code === 'E_AI_KEY_REQUIRED' ? t('keyNotSetTitle') : t('failed') }), meta));
    sheet.append(h('p', { class: 'p-rationale', text: code === 'E_AI_KEY_REQUIRED' ? t('keyNotSetBody') : errorText(code, p.error?.detail) }));
    if (steps && code !== 'E_AI_KEY_REQUIRED') { steps.open = true; sheet.append(steps); }
    const actions = h('div', { class: 'p-actions' }, h('span', { class: 'hint' }), h('button', { class: 'btn', type: 'button', text: t('dismiss'), onclick: () => clearProposal() }));
    if (code === 'E_AI_KEY_REQUIRED') actions.append(h('button', { class: 'btn primary', type: 'button', text: t('tryMock'), onclick: () => runEdit(p.instruction, { provider: 'mock' }) }));
    else if (p.instruction) actions.append(h('button', { class: 'btn primary', type: 'button', text: t('retry'), onclick: () => runEdit(p.instruction) }));
    sheet.append(actions);
    // failure feedback once, on the causal frame: a single nudge of the card
    morph.nudge(-900);
  }
  openCard();
  renderCommand();
  if (p.status === 'clarification') requestAnimationFrame(() => sheet.querySelector('input')?.focus());
}
function clearProposal({ silent = false, keepCard = false } = {}) {
  const had = state.proposal; state.proposal = null;
  stage.classList.remove('diffing'); view.setDiff(null);
  if (!keepCard && morph.open) { $('proposal').classList.remove('is-open'); morph.hide(); }
  if (had?.previewId && !silent && state.doc) api('v2/reject', { sessionId: state.doc.sessionId }).catch(() => {});
  renderCommand();
}
function reject() { if (!state.proposal) return; clearProposal(); toast.info(t('rejected')); }
async function accept() {
  const p = state.proposal; if (!p?.previewId || state.busy) return;
  const btn = $('accept-btn'); if (btn) btn.disabled = true;
  const keep = [...state.selection].map(i => state.doc.scene.ents[i].id), before = state.doc.scene;
  try {
    const r = await api('v2/accept', { sessionId: state.doc.sessionId, previewId: p.previewId });
    const file = r.savedPath.split(/[\\/]/u).pop();
    state.history = [...state.history, { label: summarizeOps(p.ops, getLang()) || t('manual'), time: new Date().toLocaleTimeString(getLang() === 'en' ? 'en-US' : 'ja-JP', { hour: '2-digit', minute: '2-digit' }),
      file, before, after: r.scene, bbox: p.diff?.bbox ?? null }].slice(-20);
    receiveDoc(r, { keepCamera: true, keepSelectionIds: keep });
    await refreshFiles();
    toast.success(t('saved'), { description: file, action: { label: t('undo'), onClick: undo } });
    settleSaved();
  } catch (e) { if (btn) btn.disabled = false; toast.error(errorText(e.code)); }
}
/** Success "settle": the card has folded back into the bar; the send button becomes a check that lands once. */
function settleSaved() {
  const chip = $('doc-chip'); chip.__motion = undefined;
  const send = $('send'); send.classList.add('saved');
  if (!prefersReducedMotion()) {
    animate(chip, { scale: 0.8 }, { immediate: true }); animate(chip, { scale: 1 }, SPRINGS.check);
    const svg = send.querySelector('.saved-check'); if (svg) { svg.__motion = undefined; animate(svg, { scale: 0.4, opacity: 0 }, { immediate: true }); animate(svg, { scale: 1, opacity: 1 }, SPRINGS.check); }
  }
  clearTimeout(settleSaved.timer); settleSaved.timer = setTimeout(() => send.classList.remove('saved'), 1400);
}
async function undo({ quiet = false } = {}) {
  if (!state.doc?.canUndo || state.busy) { if (!quiet) toast.info(t('nothingToUndo')); return false; }
  try {
    const r = await api('v2/undo', { sessionId: state.doc.sessionId });
    state.history = state.history.slice(0, -1);
    receiveDoc(r, { keepCamera: true }); if (!quiet) toast.info(t('undone')); return true;
  } catch (e) { toast.error(errorText(e.code)); return false; }
}
async function fixLayers() {
  const p = state.proposal; if (!p?.previewId) return;
  setBusy(true, true);
  try { showProposal({ ...(await api('v2/fix-layers', { sessionId: state.doc.sessionId, previewId: p.previewId })), manual: true, keepCamera: true }); }
  catch (e) { toast.error(errorText(e.code)); } finally { setBusy(false); }
}

// ---- direct manipulation: Δ chip + commit ------------------------------------------------------------------------------
function updateDragChip(info) {
  const chip = $('drag-chip');
  if (!info) { chip.hidden = true; return; }
  const [dx, dy] = info.model, f = v => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmtNum(Math.abs(v), 1)}`;
  chip.hidden = false;
  chip.querySelector('.dx').textContent = `Δx ${f(dx)}`; chip.querySelector('.dy').textContent = `Δy ${f(dy)}`;
  const tag = chip.querySelector('.snap'), s = info.snap;
  tag.textContent = info.free ? t('dragFree') : s?.kind === 'endpoint' ? t('dragEnd') : s?.kind === 'grid' ? ((s.axes.x && s.major.x) || (s.axes.y && s.major.y) ? t('dragGridMajor') : t('dragGrid')) : '';
  tag.hidden = !tag.textContent; chip.classList.toggle('engaged', !!info.engaged);
  // follows the cursor 1:1 (no spring: it is part of the gesture), offset so it never sits under the pointer
  const r = stage.getBoundingClientRect(), x = Math.min(innerWidth - 180, info.clientX + 16), y = Math.max(r.top + 60, info.clientY - 40);
  chip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}
async function commitDragMove(ids, dx, dy) {
  const ok = await manualPatch([{ op: 'translate', ids: ids.map(i => state.doc.scene.ents[i].id), dx, dy }], { keepCamera: true });
  if (!ok) view.clearMove();
}

// ---- settings, shortcuts, generator ----------------------------------------------------------------------------------------
function switchEl(on, label, onChange) {
  const b = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': label }, h('span', { class: 'knob' }));
  const knob = b.firstChild; animate(knob, { x: on ? 16 : 0 }, { immediate: true });
  b.addEventListener('click', () => { const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); animate(knob, { x: v ? 16 : 0 }, SPRINGS.flick); onChange(v); });
  return b;
}
function segmentedEl(options, value, onChange, label) {
  const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  for (const [v, text] of options) seg.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), onclick: e => {
    for (const b of seg.querySelectorAll('[role=radio]')) b.setAttribute('aria-checked', String(b === e.currentTarget)); seg.__pill?.sync({ instant: e.detail === 0 }); onChange(v); } }, text));
  attachPill(seg);
  return seg;
}
function renderSettings() {
  const s = $('settings'), ai = state.ai; s.replaceChildren();
  const saveAi = async patch => { try { state.ai = await api('v2/settings', patch); toast.success(t('settingsSaved')); renderCommand(); } catch (e) { toast.error(errorText(e.code)); } };
  s.append(h('div', { class: 'pop-head' }, h('h2', { id: 'settings-h', text: t('settings') }), h('button', { class: 'icon-btn small', type: 'button', 'data-close': '', onclick: () => hideSheet(s) }, icon('x'))));
  if (ai) {
    const provSel = h('select', { class: 'select', 'aria-label': t('defaultProvider') }, [['claude', t('providerClaude')], ['claude-fast', t('providerClaudeFast')], ['openai', t('providerOpenAI')]].map(([v, l]) => h('option', { value: v, text: l, selected: ai.provider === v })));
    provSel.addEventListener('change', () => saveAi({ provider: provSel.value }));
    s.append(h('div', { class: 'pop-sec' }, h('h3', { text: t('settingsAI') }), h('label', { class: 'field' }, h('span', { text: t('defaultProvider') }), provSel),
      h('div', { class: 'field' }, h('span', { text: t('keys') }),
        h('div', { class: 'key-row' }, h('span', {}, 'Claude ', h('code', { text: 'ANTHROPIC_API_KEY' })), h('span', { class: `state ${ai.keys.claude ? 'on' : 'off'}`, text: ai.keys.claude ? t('keySet') : t('keyUnset') })),
        h('div', { class: 'key-row' }, h('span', {}, 'OpenAI ', h('code', { text: 'OPENAI_API_KEY' })), h('span', { class: `state ${ai.keys.openai ? 'on' : 'off'}`, text: ai.keys.openai ? t('keySet') : t('keyUnset') }))),
      h('p', { class: 'note', text: t('keyNote') })));
    s.append(h('div', { class: 'pop-sec' }, h('h3', { text: t('dataPolicy') }),
      h('div', { class: 'toggle-row' }, h('div', { class: 't-text' }, h('span', { text: t('sendReal') }), h('small', { text: t('sendRealNote') })), switchEl(ai.dataPolicy.sendRealDrawings, t('sendReal'), v => saveAi({ dataPolicy: { sendRealDrawings: v } }))),
      h('div', { class: 'toggle-row' }, h('div', { class: 't-text' }, h('span', { text: t('redact') }), h('small', { text: t('redactNote') })), switchEl(ai.dataPolicy.redactText, t('redact'), v => saveAi({ dataPolicy: { redactText: v } })))));
  }
  s.append(h('div', { class: 'pop-sec' }, h('h3', { text: t('display') }),
    h('div', { class: 'field' }, h('span', { text: t('language') }), segmentedEl([['ja', '日本語'], ['en', 'English']], getLang(), v => { store.set('fresco-studio-locale', v); applyLang(); renderSettings(); }, t('language'))),
    h('div', { class: 'field' }, h('span', { text: t('theme') }), segmentedEl([['system', t('themeSystem')], ['light', t('themeLight')], ['dark', t('themeDark')]], store.get('fresco-studio-theme', 'system'), v => { store.set('fresco-studio-theme', v); applyTheme(); }, t('theme'))),
    h('div', { class: 'toggle-row' }, h('div', { class: 't-text' }, h('span', { text: t('reduceMotion') }), h('small', { text: t('reduceMotionNote') })), switchEl(readStoredReducedMotion(), t('reduceMotion'), v => { storeReducedMotion(v); applyMotionPref(); }))));
  s.append(h('p', { class: 'credits', text: t('credits') }));
}
function renderShortcuts() {
  const s = $('shortcuts'); s.replaceChildren(h('div', { class: 'pop-head' }, h('h2', { id: 'shortcuts-h', text: t('shortcuts') }), h('button', { class: 'icon-btn small', type: 'button', 'data-close': '', onclick: () => hideSheet(s) }, icon('x'))),
    h('dl', { class: 'sc-list' }, [...t('shortcutsList'), ...t('shortcutsList2')].flatMap(([k, d]) => [h('dt', {}, h('kbd', { text: isMac ? k.split(' / ')[0] : (k.split(' / ')[1] ?? k) })), h('dd', { text: d })])));
}
async function renderGenerator() {
  const s = $('generator'); s.replaceChildren(h('div', { class: 'pop-head' }, h('h2', { id: 'generator-h', text: t('generatorTitle') }), h('button', { class: 'icon-btn small', type: 'button', 'data-close': '', onclick: () => hideSheet(s) }, icon('x'))),
    h('p', { class: 'note', text: t('generatorBody') }));
  const area = h('textarea', { class: 'input', spellcheck: 'false', 'aria-label': 'JSON' }), errs = h('ul', { class: 'spec-errors' });
  s.append(area, errs, h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', type: 'button', text: t('generate'), onclick: async () => {
    errs.replaceChildren(); let spec;
    try { spec = JSON.parse(area.value); } catch (e) { errs.append(h('li', { text: e.message })); return; }
    try {
      const r = await api('v2/generate', { spec });
      if (r.status === 'invalid') { errs.append(...r.details.map(d => h('li', { text: d }))); toast.error(t('invalidSpec')); return; }
      hideSheet(s); if (state.doc) api('v2/close', { sessionId: state.doc.sessionId }).catch(() => {});
      receiveDoc(r, { fileId: null }); await refreshFiles(); toast.success(t('generated'), { description: r.savedPath.split(/[\/]/u).pop() });
    } catch (e) { toast.error(errorText(e.code)); }
  } })));
  try { const g = await api('v2/generator'); area.value = g.example ?? '{}'; } catch {}
}
const toggleSheet = (id, render, trigger, keyboard) => { const s = $(id); if (isOpen(s)) { hideSheet(s); return; } for (const o of ['settings', 'shortcuts', 'generator']) if (o !== id) hideSheet($(o), { restoreFocus: false }); render(); showSheet(s, trigger, { keyboard }); };
$('open-settings').addEventListener('click', e => toggleSheet('settings', renderSettings, e.currentTarget, e.detail === 0));
$('open-shortcuts').addEventListener('click', e => toggleSheet('shortcuts', renderShortcuts, e.currentTarget, e.detail === 0));
$('open-generator').addEventListener('click', e => toggleSheet('generator', renderGenerator, e.currentTarget, e.detail === 0));

// ---- chrome --------------------------------------------------------------------------------------------------------------
function setPanel(which, visible, { animateIt = true } = {}) {
  const el = $(which), cls = which === 'sidebar' ? 'no-sidebar' : 'no-inspector', dir = which === 'sidebar' ? -1 : 1;
  app.classList.toggle(cls, !visible);
  $(`toggle-${which}`).setAttribute('aria-pressed', String(visible));
  el.inert = !visible;
  const width = el.offsetWidth + 16;
  animate(el, { x: visible ? 0 : dir * width, opacity: visible ? 1 : 0 }, animateIt ? SPRINGS.sheet : { immediate: true });
  layoutChrome();
  if (animateIt) store.set(`fresco-studio-${which}`, visible ? 'on' : 'off');
}
function layoutChrome() {
  const l = app.classList.contains('no-sidebar') ? 16 : 296, r = app.classList.contains('no-inspector') ? 16 : 328;
  app.style.setProperty('--dock-l', `${l}px`); app.style.setProperty('--dock-r', `${r}px`); app.style.setProperty('--hud-l', `${l}px`);
}
$('toggle-sidebar').addEventListener('click', () => setPanel('sidebar', app.classList.contains('no-sidebar')));
$('toggle-inspector').addEventListener('click', () => setPanel('inspector', app.classList.contains('no-inspector')));
$('tool-seg').addEventListener('click', e => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool, { keyboard: e.detail === 0 }); });
// tool changes from V/H are keyboard-initiated: the pill jumps (no animation); a click slides it
function setTool(tool, { keyboard = true } = {}) { view.setTool(tool); for (const b of $('tool-seg').querySelectorAll('[data-tool]')) b.setAttribute('aria-checked', String(b.dataset.tool === tool)); $('tool-seg').__pill?.sync({ instant: keyboard }); }
$('zoom-in').addEventListener('click', () => view.zoomAt(1.4, undefined, undefined, { animate: true }));
$('zoom-out').addEventListener('click', () => view.zoomAt(1 / 1.4, undefined, undefined, { animate: true }));
$('fit').addEventListener('click', () => view.fitAll());
$('zoom-readout').addEventListener('click', () => view.fitAll());
$('refresh-files').addEventListener('click', () => refreshFiles().catch(e => toast.error(errorText(e.code))));
$('empty-search').addEventListener('click', () => { setPanel('sidebar', true); $('file-search').focus(); });
$('empty-generate').addEventListener('click', e => toggleSheet('generator', renderGenerator, e.currentTarget, e.detail === 0));
$('file-search').addEventListener('input', e => { state.fileFilter = e.target.value; renderFiles(); });

// ---- wave 2: context menu, focus mode, history scrubber, minimap ---------------------------------------------------------
function selectionScreenCenter() {
  const b = view.boundsOf(state.selection), r = $('canvas-overlay').getBoundingClientRect();
  if (!b) return [r.left + r.width / 2, r.top + r.height / 2];
  const [x, y] = view.toScreen((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
  return [r.left + Math.max(40, Math.min(r.width - 40, x)), r.top + Math.max(80, Math.min(r.height - 120, y))];
}
function openCanvasMenu(x, y, keyboard) {
  if (!state.doc) return;
  if (keyboard) [x, y] = selectionScreenCenter();
  const sel = [...state.selection], scene = state.doc.scene, one = sel.length ? scene.ents[sel[0]] : null;
  const layerIdx = one ? one.l : -1, layer = layerIdx >= 0 ? scene.layers[layerIdx] : null, has = sel.length > 0, free = !state.busy && !state.proposal;
  const items = [
    { label: t('ctxZoomSel'), kbd: '⇧F', disabled: !has, onSelect: () => view.fitSelection() },
    { label: t('ctxFitAll'), kbd: 'F', onSelect: () => view.fitAll() },
    { label: state.focus ? t('ctxFocusOff') : t('ctxFocus'), kbd: '.', disabled: !has && !state.focus, onSelect: () => setFocus(!state.focus) },
    'sep',
    { label: t('ctxSelectLayer'), disabled: !layer, onSelect: () => { const idx = scene.ents.map((e, i) => (e.l === layerIdx ? i : -1)).filter(i => i >= 0); select(idx, 'replace'); } },
    { label: t('ctxSolo'), disabled: !layer, onSelect: () => toggleLayer(layerIdx, true, null) },
    { label: t('ctxHideLayer'), disabled: !layer, onSelect: () => { state.hidden.add(layerIdx); view.setHiddenLayers(state.hidden); minimap.redraw(); select([], 'replace', { quiet: true }); renderLayers(); } },
    { label: t('ctxShowAll'), disabled: !state.hidden.size, onSelect: () => { state.hidden.clear(); view.setHiddenLayers(state.hidden); minimap.redraw(); renderLayers(); } },
    'sep',
    { label: t('ctxAsk'), kbd: isMac ? '⌘K' : 'Ctrl K', disabled: !free, onSelect: () => { const c = $('command'); c.focus(); c.select(); } },
    { label: t('ctxMove'), disabled: !has || !free, onSelect: () => { setPanel('inspector', true); setTab('selection', { keyboard: true }); requestAnimationFrame(() => $('insp-selection').querySelector('.group:last-child input')?.focus()); } },
    { label: t('ctxCopyId'), disabled: sel.length !== 1, onSelect: () => navigator.clipboard?.writeText(one.id).then(() => toast.info(t('copied'), { description: one.id })).catch(() => {}) },
    { label: t('ctxDelete'), danger: true, disabled: !has || !free, onSelect: () => manualPatch([{ op: 'delete', ids: sel.map(i => scene.ents[i].id) }], { keepCamera: true }) }
  ];
  openContextMenu(x, y, items, { keyboard, label: t('ctxLabel') });
}
/** Focus mode: dim everything but the selection (base layer fades; the selection stays crisp on the overlay). */
function setFocus(on) {
  on = !!on && state.selection.size > 0;
  if (state.focus === on) return;
  state.focus = on; stage.classList.toggle('focus-mode', on);
  const chip = $('focus-chip'); chip.textContent = t('focusOn');
  if (on) { chip.hidden = false; chip.__motion = undefined; animate(chip, prefersReducedMotion() ? { opacity: 0 } : { opacity: 0, y: -6 }, { immediate: true }); animate(chip, { opacity: 1, y: 0 }, SPRINGS.default); }
  else animate(chip, { opacity: 0 }, SPRINGS.snappy).finished.then(done => { if (done && !state.focus) chip.hidden = true; });
  $('live').textContent = on ? t('focusOn') : '';
}

// history: state k = scene after the k-th accepted edit (0 = as opened); the current state is history.length
const stateScene = k => (k >= state.history.length ? state.doc?.scene : k === 0 ? state.history[0].before : state.history[k - 1].after);
function renderHistoryThumb(canvas, k, w, hgt) {
  const scene = stateScene(k), ctx = canvas.getContext('2d'), d = globalThis.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!scene?.bbox) return;
  const b = scene.bbox, s = Math.min((w - 12) / (b[2] - b[0] || 1), (hgt - 12) / (b[3] - b[1] || 1)), ox = (w - (b[2] - b[0]) * s) / 2, oy = (hgt - (b[3] - b[1]) * s) / 2;
  ctx.setTransform(d * s, 0, 0, -d * s, d * (ox - b[0] * s), d * (hgt - oy + b[1] * s));
  const path = new Path2D();
  for (const p of scene.prims) { if (p.t === 4 || state.hidden.has(p.l) || p.p.length < 4) continue; path.moveTo(p.p[0], p.p[1]); for (let i = 2; i < p.p.length; i += 2) path.lineTo(p.p[i], p.p[i + 1]); }
  ctx.strokeStyle = view.palette.fg; ctx.globalAlpha = 0.6; ctx.lineWidth = 0.7 / s; ctx.stroke(path);
  const bb = k > 0 ? state.history[k - 1]?.bbox : null;
  if (bb) { // where that edit happened
    const pad = 6 / s; ctx.globalAlpha = 1; ctx.strokeStyle = view.accent; ctx.lineWidth = 1.5 / s;
    ctx.strokeRect(bb[0] - pad, bb[1] - pad, bb[2] - bb[0] + pad * 2, bb[3] - bb[1] + pad * 2);
  }
}
let scrubbing = false;
/** Scrub position p ∈ [0, n]: cross-fade the two neighbouring states on the canvas (opacity only, no per-frame redraw). */
function scrubHistory(p) {
  const n = state.history.length, base = $('canvas-base'), A = $('canvas-compare-a'), B = $('canvas-compare-b');
  if (!state.doc || p >= n - 1e-3) {
    if (scrubbing) { scrubbing = false; stage.classList.remove('history-scrub'); base.style.opacity = ''; A.style.opacity = B.style.opacity = '0'; view.setCompareLayer(0, null); view.setCompareLayer(1, null); }
    return;
  }
  if (!scrubbing) { scrubbing = true; stage.classList.add('history-scrub'); }
  const lo = Math.floor(p), hi = Math.min(n, lo + 1), f = p - lo;
  // lower state on A; the upper state is either the live base canvas (hi = n) or B
  view.setCompareLayer(0, stateScene(lo));
  if (hi >= n) { view.setCompareLayer(1, null); base.style.opacity = String(f); B.style.opacity = '0'; }
  else { view.setCompareLayer(1, stateScene(hi)); base.style.opacity = '0'; B.style.opacity = String(f); }
  A.style.opacity = String(1 - f);
}
function endHistoryPreview() { if (history?.previewing) history.endPreview(); else scrubHistory(Infinity); }
async function restoreHistory(k) {
  const n = state.history.length; if (k >= n || state.busy) return;
  clearProposal();
  const id = toast.loading(t('restoring'));
  let ok = true;
  for (let i = n; i > k && ok; i--) ok = await undo({ quiet: true });
  scrubHistory(Infinity);
  toast.dismiss(id);
  if (ok) toast.info(t('restored', { k }));
}

function initWave2() {
  morph = createMorph({ card: $('proposal'), bar: $('commandbar'), content: $('proposal-content') });
  minimap = createMinimap({ host: stage, view, label: t('minimap') });
  history = createHistory({ host: stage, t, renderThumb: renderHistoryThumb, onScrub: scrubHistory, onRestore: restoreHistory, onPreviewEnd: () => scrubHistory(Infinity) });
  initTooltips(document);
  for (const id of ['tool-seg', 'insp-tabs', 'layer-sort']) attachPill($(id));
  for (const b of $('layer-sort').querySelectorAll('[role=radio]')) b.setAttribute('aria-checked', String(b.dataset.sort === state.layerSort));
}
initWave2();

// ---- keyboard ---------------------------------------------------------------------------------------------------------------
const typing = el => el && (el.matches('input, textarea, select') || el.isContentEditable);
document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); const c = $('command'); if (!c.disabled) { c.focus(); c.select(); } return; }
  if (mod && e.key === 'Enter' && state.proposal?.previewId) { e.preventDefault(); accept(); return; }
  if (mod && e.key.toLowerCase() === 'z' && !typing(document.activeElement)) { e.preventDefault(); undo(); return; }
  if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && state.doc && !typing(document.activeElement)) { e.preventDefault(); openCanvasMenu(0, 0, true); return; }
  if (e.key === 'Escape') {
    if (contextMenuOpen()) { closeContextMenu(); return; }
    if (view.drag?.mode === 'move') { view.abortMove(); return; }
    const top = topSheet();
    if (top) { hideSheet(top); return; }
    if (history.previewing) { endHistoryPreview(); return; }
    if (state.proposal) { e.preventDefault(); reject(); return; }
    if (typing(document.activeElement)) { document.activeElement.blur(); return; }
    if (state.focus) { setFocus(false); return; }
    if (state.selection.size) { select([], 'replace'); return; }
    return;
  }
  if (typing(document.activeElement) || mod || e.altKey) return;
  if (e.key === ' ' && !e.repeat && state.doc && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); view.setSpace(true); return; }
  if (!state.doc) { if (e.key === '?') toggleSheet('shortcuts', renderShortcuts, $('open-shortcuts'), true); return; }
  const k = e.key;
  if (k === '?') { toggleSheet('shortcuts', renderShortcuts, $('open-shortcuts'), true); return; }
  if (k === '.') { setFocus(!state.focus); return; }
  if (k === 'f' || k === 'F') { e.shiftKey ? view.fitSelection() : view.fitAll(); return; }
  if (k === 'v' || k === 'V') { setTool('select'); return; }
  if (k === 'h' || k === 'H') { setTool('pan'); return; }
  if (k === '+' || k === '=') { view.zoomAt(1.25, undefined, undefined, { animate: true }); return; }
  if (k === '-' || k === '_') { view.zoomAt(0.8, undefined, undefined, { animate: true }); return; }
  const step = e.shiftKey ? 240 : 80, arrows = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  if (arrows[k] && (document.activeElement === $('canvas-overlay') || document.activeElement === document.body)) {
    e.preventDefault(); const c = view.cameraFor ? view.cam : null; if (!c) return;
    view.springTo({ cx: c.cx - arrows[k][0] / c.z, cy: c.cy + arrows[k][1] / c.z, z: c.z }, SPRINGS.move);
  }
});
document.addEventListener('keyup', e => { if (e.key === ' ') view.setSpace(false); });
window.addEventListener('blur', () => view.setSpace(false));
window.addEventListener('beforeunload', e => { if (state.proposal?.previewId) { e.preventDefault(); e.returnValue = ''; } });

function renderAll() { renderFiles(); renderLayers(); renderInspector(); renderCheck(); renderCommand(); }

// ---- boot ---------------------------------------------------------------------------------------------------------------
async function boot() {
  applyMotionPref();
  const r = await api('v2/bootstrap');
  Object.assign(state, { token: r.token, files: r.files, rootConfigured: r.rootConfigured, ai: r.ai, pens: r.pens, generator: r.generator });
  $('open-generator').hidden = !r.generator; $('empty-generate').hidden = !r.generator;
  $('empty-hint').hidden = r.rootConfigured; $('empty-hint').textContent = t('noRootBody');
  applyTheme(); applyLang();
  const narrow = innerWidth < 1100, tiny = innerWidth < 760;
  setPanel('sidebar', !tiny && store.get('fresco-studio-sidebar', 'on') === 'on', { animateIt: false });
  setPanel('inspector', !narrow && store.get('fresco-studio-inspector', 'on') === 'on', { animateIt: false });
}
boot().catch(e => toast.error(errorText(e.code ?? 'E_STUDIO_OPERATION')));
// Debug handle for local inspection (no secrets live in the page).
globalThis.__studio = { view, state };
