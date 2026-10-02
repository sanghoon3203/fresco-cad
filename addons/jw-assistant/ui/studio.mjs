// Fresco Studio controller: files → scene → canvas; selection → inspector; command bar → /api/v2/edit → proposal
// (op chips + canvas diff) → accept (new JWW) / reject / undo. Server contract: tools/studio-server.mjs (/api/v2/*).
import { DrawingView } from './studio-canvas.mjs';
import { animate, SPRINGS, prefersReducedMotion, readStoredReducedMotion, storeReducedMotion, setReducedMotion } from './motion.mjs';
import { t, setLang, getLang } from './studio/i18n.mjs';
import { createToaster } from './studio/toast.mjs';
import { describeOp, summarizeOps } from './studio/ops.mjs';
import { showSheet, hideSheet, isOpen, topSheet } from './studio/sheet.mjs';

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
  tab: 'selection', fileFilter: '', openingId: null, details: null, checkLayer: null
};
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
  renderAll();
}
function applyMotionPref() { const v = readStoredReducedMotion(); setReducedMotion(v); document.body.classList.toggle('reduce-motion', v); }

// ---- canvas ----------------------------------------------------------------------------------------------------------
const view = new DrawingView({
  base: $('canvas-base'), overlay: $('canvas-overlay'), host: stage,
  insets: () => ({ l: app.classList.contains('no-sidebar') ? 16 : 296, t: 68, r: app.classList.contains('no-inspector') ? 16 : 328, b: Math.max(92, innerHeight - $('dock').getBoundingClientRect().top + 16) }),
  onSelect: (indices, mode) => select(indices, mode),
  onCamera: cam => { $('zoom-readout').textContent = `${fmtNum(cam.z / 3.7795 * 100)}%`; $('zoom-readout').title = t('zoomLabel', { z: fmtNum(cam.z / 3.7795 * 100) }); },
  onPointer: p => updateCursor(p)
});
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
  state.openingId = f.id; renderFiles(); $('loading').hidden = false;
  try {
    const r = await api('v2/open', { fileId: f.id });
    if (state.doc) api('v2/close', { sessionId: state.doc.sessionId }).catch(() => {});
    receiveDoc(r, { fileId: f.id });
    toast.success(t('opened', { name: r.name }), { description: `${fmtNum(r.scene.ents.length)} ${getLang() === 'en' ? 'entities' : '要素'}` });
  } catch (e) { toast.error(t('openFailed'), { description: errorText(e.code) }); }
  finally { state.openingId = null; $('loading').hidden = true; renderFiles(); }
}
function receiveDoc(r, { fileId = state.doc?.fileId, keepCamera = false, keepSelectionIds = null } = {}) {
  const scene = r.scene, counts = new Map();
  for (const e of scene.ents) counts.set(scene.layers[e.l]?.scale ?? 1, (counts.get(scene.layers[e.l]?.scale ?? 1) ?? 0) + 1);
  const mainScale = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1;
  const firstOpen = !state.doc || state.doc.sessionId !== r.sessionId;
  state.doc = { ...r, fileId, mainScale, idIndex: new Map(scene.ents.map((e, i) => [e.id, i])) };
  if (firstOpen) state.hidden = new Set(scene.layers.map((l, i) => (l.state === 0 && l.count ? i : -1)).filter(i => i >= 0));
  clearProposal({ silent: true });
  view.setScene(scene, { keepCamera });
  view.setHiddenLayers(state.hidden);
  const sel = keepSelectionIds ? keepSelectionIds.map(id => state.doc.idIndex.get(id)).filter(i => i !== undefined) : [];
  select(sel, 'replace', { quiet: true });
  $('empty').hidden = true; $('canvas-tools').hidden = false; $('hud').hidden = false;
  $('doc-name').textContent = r.name;
  const chip = $('doc-chip'); chip.hidden = !r.savedPath; chip.textContent = r.savedPath ? (getLang() === 'en' ? 'Saved copy' : '保存済みコピー') : '';
  $('hud-scale').textContent = `1:${fmtNum(mainScale)}`;
  renderLayers(); renderInspector(); renderCommand(); renderCheck();
}

// ---- layers ---------------------------------------------------------------------------------------------------------------
function renderLayers() {
  const list = $('layer-list'); list.replaceChildren();
  const scene = state.doc?.scene;
  if (!scene) { $('layers-all').hidden = true; return; }
  $('layers-all').hidden = !state.hidden.size;
  const byGroup = new Map();
  scene.layers.forEach((l, i) => { if (!l.count) return; const g = l.id.split(':')[0]; (byGroup.get(g) ?? byGroup.set(g, []).get(g)).push([l, i]); });
  let n = 0;
  for (const [g, rows] of byGroup) {
    const first = rows[0][0];
    list.append(h('div', { class: 'group-head' }, h('b', { text: `${t('group')} ${g}` }), first.groupName ? first.groupName : '', `· 1:${fmtNum(first.scale)}`));
    for (const [l, i] of rows) {
      const on = !state.hidden.has(i);
      const box = h('button', { class: 'check', type: 'button', role: 'checkbox', 'aria-checked': String(on), 'aria-label': `${l.id} ${l.name || ''}`, title: t('soloHint'),
        onclick: e => toggleLayer(i, e.altKey, box) }, h('span', { class: 'box' }, icon('check')));
      const role = l.roleJa ? `${l.roleJa}${l.roleSource === 'profile' ? ` · ${t('roleFromProfile')}` : ''}` : l.ruleJa ? `${l.ruleJa} · ${t('ruleLayer')}` : '';
      const c = l.check, badge = c && (c.error || c.warning) ? h('button', { class: `badge ${c.error ? 'error' : 'warning'}`, type: 'button', title: t('checkSummary', { e: c.error ?? 0, w: c.warning ?? 0, i: c.info ?? 0 }),
        onclick: () => { state.checkLayer = l.id; setTab('check'); } }, String((c.error ?? 0) + (c.warning ?? 0))) : null;
      const row = h('div', { class: `layer-row${on ? '' : ' off'}` }, box,
        h('div', { class: 'l-main' }, h('span', { class: 'l-name' }, h('span', { class: 'lid', text: l.id }), l.name || t('unnamed')), role ? h('span', { class: 'l-role', text: role }) : null),
        h('div', { class: 'l-side' }, badge, h('span', { class: 'l-count', text: fmtNum(l.count) })));
      if (!list.dataset.entered && n < 14) { row.classList.add('stagger'); row.style.animationDelay = `${n * 24}ms`; }
      n++; list.append(row);
    }
  }
  list.dataset.entered = '1';
}
function toggleLayer(i, solo, box) {
  const used = state.doc.scene.layers.map((l, k) => (l.count ? k : -1)).filter(k => k >= 0);
  if (solo) state.hidden = new Set(used.filter(k => k !== i));
  else if (state.hidden.has(i)) state.hidden.delete(i); else state.hidden.add(i);
  view.setHiddenLayers(state.hidden);
  const on = !state.hidden.has(i);
  if (solo) renderLayers();
  else {
    box.setAttribute('aria-checked', String(on)); box.closest('.layer-row').classList.toggle('off', !on); $('layers-all').hidden = !state.hidden.size;
    // springy checkmark: the tick lands with a little life; unticking is quick and quiet
    const svg = box.querySelector('svg');
    if (on && !prefersReducedMotion()) { svg.__motion = undefined; animate(svg, { scale: 0.4 }, { immediate: true }); animate(svg, { scale: 1 }, SPRINGS.check); }
    const b = box.querySelector('.box'); b.__motion = undefined; if (!prefersReducedMotion()) { animate(b, { scale: 0.86 }, { immediate: true }); animate(b, { scale: 1 }, SPRINGS.check); }
  }
}
$('layers-all').addEventListener('click', () => { state.hidden.clear(); view.setHiddenLayers(state.hidden); renderLayers(); });

// ---- selection & inspector -------------------------------------------------------------------------------------------
function select(indices, mode = 'replace', { quiet = false } = {}) {
  let next = mode === 'replace' ? new Set() : new Set(state.selection);
  for (const i of indices) { if (mode === 'toggle' && next.has(i)) next.delete(i); else next.add(i); }
  if (next.size > 500) next = new Set([...next].slice(0, 500));
  state.selection = next; view.setSelection(next);
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
function setTab(tab) {
  state.tab = tab;
  for (const b of $('insp-tabs').querySelectorAll('[role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('insp-selection').hidden = tab !== 'selection'; $('insp-check').hidden = tab !== 'check';
  if (tab === 'check') renderCheck();
}
$('insp-tabs').addEventListener('click', e => { const b = e.target.closest('[role=tab]'); if (b) { if (b.dataset.tab === 'check') state.checkLayer = null; setTab(b.dataset.tab); } });
$('insp-tabs').addEventListener('keydown', e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { const next = state.tab === 'selection' ? 'check' : 'selection'; setTab(next); $(`tab-${next}`).focus(); } });

const layerOptions = (current) => {
  const sel = h('select', { class: 'select', 'aria-label': t('layer') });
  state.doc.scene.layers.forEach(l => { if (l.count || l.name || l.id === current) sel.append(h('option', { value: l.id, text: `${l.id}  ${l.name || l.roleJa || ''}`.trim(), selected: l.id === current })); });
  return sel;
};
const numInput = (value, axis, onCommit, label) => {
  const input = h('input', { class: 'input', type: 'number', step: 'any', value: Number.isFinite(value) ? String(value) : '', 'aria-label': label });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); onCommit(); } });
  return axis ? h('label', { class: 'axis', 'data-axis': axis }, input) : input;
};
function renderInspector() {
  const body = $('insp-selection'); body.replaceChildren();
  const doc = state.doc;
  if (!doc) { body.append(h('div', { class: 'empty-insp' }, h('h3', { text: t('inspectorSelection') }), h('p', { class: 'note', text: t('inspectorEmpty') }))); return; }
  const scene = doc.scene, sel = [...state.selection];
  if (!sel.length) {
    const used = scene.layers.filter(l => l.count).length, b = scene.bbox;
    const s = scene.check?.summary;
    body.append(h('div', { class: 'insp-head' }, h('span', { class: 'kind-icon' }, icon('doc')), h('h3', { text: doc.name })));
    body.append(h('dl', { class: 'kv' }, h('dt', { text: t('entityCount') }), h('dd', { text: fmtNum(scene.ents.length) }), h('dt', { text: t('layerCount') }), h('dd', { text: fmtNum(used) }),
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
    if (Number.isFinite(d.radius)) { const r = numInput(d.radius, null, () => { const v = Number(r.value); if (v > 0) modify(e.id, { radius: v }); }, t('radius')); geo.append(h('div', { class: 'field' }, h('span', { text: t('radius') }), r)); }
    if (d.kind === 'text') {
      const tx = h('input', { class: 'input', type: 'text', value: d.text ?? '', 'aria-label': t('text') });
      tx.addEventListener('keydown', ev => { if (ev.key === 'Enter' && tx.value.trim()) modify(e.id, { text: tx.value }); });
      const ht = numInput(d.height, null, () => { const v = Number(ht.value); if (v > 0) modify(e.id, { height: v }); }, t('height'));
      geo.append(h('div', { class: 'field' }, h('span', { text: t('text') }), tx), h('div', { class: 'field' }, h('span', { text: t('height') }), ht));
    }
    if (Number.isFinite(d.length)) geo.append(h('dl', { class: 'kv' }, h('dt', { text: t('length') }), h('dd', { text: `${fmtNum(d.length, 1)} mm` })));
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

let workTimer = 0;
function setBusy(busy, mock) {
  state.busy = busy; $('commandbar').classList.toggle('working', busy);
  clearInterval(workTimer);
  if (busy) {
    const t0 = performance.now(), label = mock ? t('workingMock') : t('working');
    const tick = () => { $('work-status').textContent = `${label} ${t('elapsed', { s: Math.floor((performance.now() - t0) / 1000) })}`; };
    tick(); workTimer = setInterval(tick, 1000);
  } else $('work-status').textContent = '';
  renderCommand();
}
async function runEdit(instruction, { provider } = {}) {
  if (!state.doc || state.busy) return;
  state.lastInstruction = instruction;
  const chosen = provider ?? state.provider, mock = (provider ?? effectiveProvider()) === 'mock';
  clearProposal({ silent: true }); setBusy(true, mock);
  try {
    const r = await api('v2/edit', { sessionId: state.doc.sessionId, baseHash: state.doc.hash, instruction, provider: chosen, selection: [...state.selection].map(i => state.doc.scene.ents[i].id) });
    showProposal({ ...r, instruction });
    if (r.status === 'applied') $('command').value = '';
  } catch (e) { showProposal({ status: 'failed', error: { code: e.code }, attempts: [], instruction }); }
  finally { setBusy(false); }
}
async function manualPatch(ops) {
  if (!state.doc || state.busy) return;
  setBusy(true, true);
  try {
    const patch = { schemaVersion: 2, sourceHash: state.doc.hash, units: 'model-mm', rationale: t('manual'), needsClarification: null, ops };
    showProposal({ ...(await api('v2/patch', { sessionId: state.doc.sessionId, baseHash: state.doc.hash, patch })), manual: true });
  } catch (e) { toast.error(errorText(e.code), e.detail ? { description: e.detail } : {}); }
  finally { setBusy(false); }
}

// ---- proposal sheet -----------------------------------------------------------------------------------------------------
function showProposal(p) {
  state.proposal = p; const sheet = $('proposal'), lang = getLang();
  sheet.replaceChildren();
  const meta = h('div', { class: 'p-meta' });
  if (p.attempts?.length) meta.append(h('span', { text: t('attempts', { n: p.attempts.length, max: state.ai?.maxAttempts ?? 3 }) }));
  if (p.provider && !p.manual) meta.append(h('span', { text: p.provider === 'mock' ? t('providerMock') : p.model ?? p.provider }));
  if (!p.manual && p.status !== 'failed' || p.costEstimate) meta.append(h('span', { text: p.demo || p.provider === 'mock' ? t('costMock') : Number.isFinite(p.costEstimate?.usd) ? t('cost', { usd: p.costEstimate.usd.toFixed(3) }) : t('cost0') }));
  if (Number.isFinite(p.latencyMs)) meta.append(h('span', { text: `${(p.latencyMs / 1000).toFixed(1)} s` }));
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
    sheet.append(h('div', { class: 'p-actions' }, h('span', { class: 'hint', text: isMac ? t('acceptHint') : t('acceptHint').replace('⌘↵', 'Ctrl+Enter') }),
      h('button', { class: 'btn', type: 'button', text: t('reject'), onclick: () => reject() }),
      h('button', { class: 'btn primary', type: 'button', id: 'accept-btn', onclick: () => accept() }, t('accept'))));
    stage.classList.add('diffing'); view.setDiff(p.diff);
    if (p.diff.bbox) {
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
    sheet.append(h('div', { class: 'reply' }, input, h('button', { class: 'btn primary', type: 'button', text: t('reply'), onclick: send })),
      h('div', { class: 'p-actions' }, h('span', { class: 'hint' }), h('button', { class: 'btn', type: 'button', text: t('dismiss'), onclick: () => clearProposal() })));
  } else {
    const code = p.error?.code ?? 'E_STUDIO_OPERATION';
    sheet.append(h('div', { class: 'p-head' }, h('span', { class: 'p-icon bad' }, icon('x')), h('h3', { text: code === 'E_AI_KEY_REQUIRED' ? t('keyNotSetTitle') : t('failed') }), meta));
    sheet.append(h('p', { class: 'p-rationale', text: code === 'E_AI_KEY_REQUIRED' ? t('keyNotSetBody') : errorText(code, p.error?.detail) }));
    if (p.attempts?.length > 1) sheet.append(h('ol', { class: 'attempt-list' }, p.attempts.map(a => h('li', { text: `${a.status}${a.error ? ` · ${a.error.code}` : ''}` }))));
    const actions = h('div', { class: 'p-actions' }, h('span', { class: 'hint' }), h('button', { class: 'btn', type: 'button', text: t('dismiss'), onclick: () => clearProposal() }));
    if (code === 'E_AI_KEY_REQUIRED') actions.append(h('button', { class: 'btn primary', type: 'button', text: t('tryMock'), onclick: () => runEdit(p.instruction, { provider: 'mock' }) }));
    else if (p.instruction) actions.append(h('button', { class: 'btn primary', type: 'button', text: t('retry'), onclick: () => runEdit(p.instruction) }));
    sheet.append(actions);
    // failure feedback once, on the causal frame: a single nudge of the bar
    const bar = $('commandbar'); bar.__motion = undefined;
    if (!prefersReducedMotion()) animate(bar, { x: 0 }, { ...SPRINGS.flick, velocity: { x: -900 } });
  }
  const wasOpen = isOpen(sheet);
  if (!wasOpen) {
    sheet.style.transformOrigin = '50% 100%'; sheet.hidden = false; sheet.__motion = undefined;
    if (prefersReducedMotion()) { animate(sheet, { opacity: 0 }, { immediate: true }); animate(sheet, { opacity: 1 }, SPRINGS.snappy); }
    else { animate(sheet, { y: 14, scale: 0.97, opacity: 0 }, { immediate: true }); animate(sheet, { y: 0, scale: 1, opacity: 1 }, SPRINGS.sheet); }
    sheet.classList.add('is-open'); markOpen(sheet);
  }
  renderCommand();
  if (p.status === 'clarification') requestAnimationFrame(() => sheet.querySelector('input')?.focus());
}
const proposalOpen = new Set(); const markOpen = s => proposalOpen.add(s);
function clearProposal({ silent = false } = {}) {
  const had = state.proposal; state.proposal = null;
  stage.classList.remove('diffing'); view.setDiff(null);
  const sheet = $('proposal');
  if (proposalOpen.has(sheet)) {
    proposalOpen.delete(sheet); sheet.classList.remove('is-open');
    const done = () => { if (!proposalOpen.has(sheet)) sheet.hidden = true; };
    (prefersReducedMotion() ? animate(sheet, { opacity: 0 }, SPRINGS.snappy) : animate(sheet, { y: 14, scale: 0.97, opacity: 0 }, SPRINGS.snappy)).finished.then(done);
  }
  if (had?.previewId && !silent && state.doc) api('v2/reject', { sessionId: state.doc.sessionId }).catch(() => {});
  renderCommand();
}
function reject() { if (!state.proposal) return; clearProposal(); toast.info(t('rejected')); }
async function accept() {
  const p = state.proposal; if (!p?.previewId || state.busy) return;
  const btn = $('accept-btn'); if (btn) btn.disabled = true;
  const keep = [...state.selection].map(i => state.doc.scene.ents[i].id);
  try {
    const r = await api('v2/accept', { sessionId: state.doc.sessionId, previewId: p.previewId });
    receiveDoc(r, { keepCamera: true, keepSelectionIds: keep });
    await refreshFiles();
    toast.success(t('saved'), { description: r.savedPath.split(/[\/]/u).pop(), action: { label: t('undo'), onClick: undo } });
    const chip = $('doc-chip'); chip.__motion = undefined;
    if (!prefersReducedMotion()) { animate(chip, { scale: 0.8 }, { immediate: true }); animate(chip, { scale: 1 }, SPRINGS.check); }
  } catch (e) { if (btn) btn.disabled = false; toast.error(errorText(e.code)); }
}
async function undo() {
  if (!state.doc?.canUndo || state.busy) { toast.info(t('nothingToUndo')); return; }
  try { const r = await api('v2/undo', { sessionId: state.doc.sessionId }); receiveDoc(r, { keepCamera: true }); toast.info(t('undone')); }
  catch (e) { toast.error(errorText(e.code)); }
}
async function fixLayers() {
  const p = state.proposal; if (!p?.previewId) return;
  setBusy(true, true);
  try { showProposal({ ...(await api('v2/fix-layers', { sessionId: state.doc.sessionId, previewId: p.previewId })), manual: true }); }
  catch (e) { toast.error(errorText(e.code)); } finally { setBusy(false); }
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
    for (const b of seg.children) b.setAttribute('aria-checked', String(b === e.currentTarget)); onChange(v); } }, text));
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
    h('dl', { class: 'sc-list' }, t('shortcutsList').flatMap(([k, d]) => [h('dt', {}, h('kbd', { text: isMac ? k.split(' / ')[0] : (k.split(' / ')[1] ?? k) })), h('dd', { text: d })])));
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
$('tool-seg').addEventListener('click', e => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
function setTool(tool) { view.setTool(tool); for (const b of $('tool-seg').children) b.setAttribute('aria-checked', String(b.dataset.tool === tool)); }
$('zoom-in').addEventListener('click', () => view.zoomAt(1.4, undefined, undefined, { animate: true }));
$('zoom-out').addEventListener('click', () => view.zoomAt(1 / 1.4, undefined, undefined, { animate: true }));
$('fit').addEventListener('click', () => view.fitAll());
$('zoom-readout').addEventListener('click', () => view.fitAll());
$('refresh-files').addEventListener('click', () => refreshFiles().catch(e => toast.error(errorText(e.code))));
$('empty-search').addEventListener('click', () => { setPanel('sidebar', true); $('file-search').focus(); });
$('empty-generate').addEventListener('click', e => toggleSheet('generator', renderGenerator, e.currentTarget, e.detail === 0));
$('file-search').addEventListener('input', e => { state.fileFilter = e.target.value; renderFiles(); });

// ---- keyboard ---------------------------------------------------------------------------------------------------------------
const typing = el => el && (el.matches('input, textarea, select') || el.isContentEditable);
document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); const c = $('command'); if (!c.disabled) { c.focus(); c.select(); } return; }
  if (mod && e.key === 'Enter' && state.proposal?.previewId) { e.preventDefault(); accept(); return; }
  if (mod && e.key.toLowerCase() === 'z' && !typing(document.activeElement)) { e.preventDefault(); undo(); return; }
  if (e.key === 'Escape') {
    const top = topSheet();
    if (top) { hideSheet(top); return; }
    if (state.proposal) { e.preventDefault(); reject(); return; }
    if (typing(document.activeElement)) { document.activeElement.blur(); return; }
    if (state.selection.size) { select([], 'replace'); return; }
    return;
  }
  if (typing(document.activeElement) || mod || e.altKey) return;
  if (e.key === ' ' && !e.repeat && state.doc && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); view.setSpace(true); return; }
  if (!state.doc) { if (e.key === '?') toggleSheet('shortcuts', renderShortcuts, $('open-shortcuts'), true); return; }
  const k = e.key;
  if (k === '?') { toggleSheet('shortcuts', renderShortcuts, $('open-shortcuts'), true); return; }
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
