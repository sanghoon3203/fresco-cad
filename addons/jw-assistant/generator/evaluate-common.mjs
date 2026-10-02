// Shared, deterministic checks for the drawing-set evaluators (elevation / section / foundation / details).
// Everything is read back from the JWW bytes with the codec (no trust in generator primitives); expected values
// come from the building model (generator/building.mjs) and the rulebooks (knowledge/office-drafting-rules-*.json).
import { readFile } from 'node:fs/promises';
import { decodeJww, semanticView } from '../native/codec/jww-codec.mjs';
import { textLength } from '../native/codec/jww-ops.mjs';
import { round } from './geometry.mjs';

export async function loadSetRules() {
  const load = n => readFile(new URL(`../knowledge/office-drafting-rules-${n}.json`, import.meta.url), 'utf8').then(JSON.parse);
  const [elevation, section, foundation] = await Promise.all([load('elevation'), load('section'), load('foundation')]);
  return { elevation, section, foundation };
}

/** Decode and flatten group `g` (default 1) entities into model mm. Group 0 kept separately (paper mm). */
export function readSheet(bytes) {
  const doc = decodeJww(bytes), view = semanticView(doc), out = [], frame = [];
  for (const e of view.entities) {
    const g = parseInt(e.layer.split(':')[0], 16), s = doc.header.m_adScale[g], M = p => [p[0] * s, p[1] * s], geo = e.geometry;
    const base = { id: e.id, layer: e.layer, group: g, kind: e.kind, color: e.pen?.color, style: e.pen?.style, scale: s };
    let it;
    if (e.kind === 'line') it = { ...base, a: M(geo.start), b: M(geo.end) };
    else if (e.kind === 'arc') it = { ...base, c: M(geo.center), r: geo.radius * s, full: !!geo.full };
    else if (e.kind === 'text') {
      const at = M(geo.at), l = textLength(geo.text, geo.width, geo.spacing) * s, h = geo.height * s, vert = Math.abs((geo.angleDegrees ?? 0) - 90) < 1;
      it = { ...base, text: geo.text, height: geo.height, width: geo.width, style: e.style ?? geo.style, at, angle: geo.angleDegrees ?? 0, box: vert ? { x1: at[0] - h, y1: at[1], x2: at[0], y2: at[1] + l } : { x1: at[0], y1: at[1], x2: at[0] + l, y2: at[1] + h } };
    } else if (e.kind === 'point') it = { ...base, at: M(geo.at) };
    else if (e.kind === 'solid') it = { ...base, pts: geo.points.map(M) };
    else it = base;
    (g === 0 ? frame : out).push(it);
  }
  return { doc, view, items: out, frame, memo: doc.header.m_strMemo ?? '', scale: doc.header.m_adScale };
}

export class Checks {
  constructor(weights, planning) { this.list = []; this.weights = weights; this.planning = planning; }
  add(id, total, failed, severity, details = []) {
    const passed = Math.max(0, total - failed), ratio = total ? passed / total : 1;
    this.list.push({ id, weight: this.weights[id] ?? 1, total, passed, ratio: round(ratio, 1000), severity, details: details.slice(0, 12) });
  }
  result(extra = {}) {
    const sub = set => { const cs = this.list.filter(c => set(c.id)), w = cs.reduce((s, c) => s + c.weight, 0); return w ? round(cs.reduce((s, c) => s + c.weight * c.ratio, 0) / w * 100, 10) : 100; };
    const drafting = sub(id => !this.planning.has(id)), planning = sub(id => this.planning.has(id));
    const findings = this.list.filter(c => c.ratio < 1).flatMap(c => c.details.length ? c.details.map(d => ({ check: c.id, severity: c.severity, message: d })) : [{ check: c.id, severity: c.severity, message: `${c.total - c.passed}/${c.total} failed` }]);
    const penalty = Math.min(20, findings.filter(f => f.severity === 'error').length * 2);
    return { score: round(Math.max(0, 0.6 * drafting + 0.4 * planning - penalty), 10), subscores: { drafting, planning, errorPenalty: penalty }, checks: this.list, findings, ...extra };
  }
}

/** Layer purity + pens: rule = {layer: {kind: [[colors], [styles]|null]}}. Returns [checked, bad[]] per check. */
export function layerAndPenChecks(items, rule) {
  const purity = [], pens = [];
  for (const it of items) {
    const r = rule[it.layer];
    if (!r || !r[it.kind]) { purity.push(`${it.kind} on ${it.layer}${it.text ? ` "${it.text}"` : ''}`); continue; }
    const [colors, styles] = r[it.kind];
    if (it.kind === 'text') continue;
    if ((colors && !colors.includes(it.color)) || (styles && !styles.includes(it.style))) pens.push(`${it.kind} on ${it.layer} pen ${it.color}/${it.style}`);
  }
  return { purity, pens };
}
export const uniqMsgs = list => { const m = new Map(); for (const s of list) m.set(s, (m.get(s) ?? 0) + 1); return [...m].map(([s, n]) => n > 1 ? `${s} (x${n})` : s); };

/** Text heights must come from the allowed set (paper mm). */
export function textSizeCheck(items, allowed) {
  const bad = items.filter(t => t.kind === 'text' && !allowed.some(h => Math.abs(h - t.height) < 0.051)).map(t => `"${t.text}" ${t.height} mm`);
  return { total: items.filter(t => t.kind === 'text').length, bad };
}

/** Everything inside the A3 frame (paper mm) of group 0. */
export function fitsSheetCheck(items, frame) {
  const fr = frame.filter(f => f.kind === 'line' && f.layer === '0:0');
  const xs = fr.flatMap(l => [l.a[0], l.b[0]]), ys = fr.flatMap(l => [l.a[1], l.b[1]]);
  const box = { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }, bad = [];
  for (const it of items) {
    const pts = it.kind === 'line' ? [it.a, it.b] : it.kind === 'arc' ? [it.c] : it.kind === 'solid' ? it.pts : it.kind === 'text' ? [[it.box.x1, it.box.y1], [it.box.x2, it.box.y2]] : it.at ? [it.at] : [];
    for (const p of pts) { const q = [p[0] / it.scale, p[1] / it.scale]; if (q[0] < box.x1 - 0.5 || q[0] > box.x2 + 0.5 || q[1] < box.y1 - 0.5 || q[1] > box.y2 + 0.5) { bad.push(`${it.kind} on ${it.layer} at ${q.map(v => round(v, 10))} outside the frame`); break; } }
  }
  return { total: items.length, bad };
}

/**
 * Dimension texts equal the distance between the two chain points around them. A chain = dimension line on a dim
 * layer with points (実点) on it; texts are matched to the nearest parallel chain within 2 text heights.
 */
export function dimensionChainCheck(items, dimLayers, { textFilter = t => /^\d{1,3}(,\d{3})*$/u.test(t.text) } = {}) {
  const lines = items.filter(i => i.kind === 'line' && dimLayers.includes(i.layer));
  const points = items.filter(i => i.kind === 'point' && dimLayers.includes(i.layer));
  const texts = items.filter(i => i.kind === 'text' && dimLayers.includes(i.layer) && textFilter(i));
  const bad = []; let total = 0;
  for (const t of texts) {
    const val = Number(t.text.replace(/,/gu, '')), vert = Math.abs(t.angle - 90) < 1, h = t.height * t.scale;
    const cx = (t.box.x1 + t.box.x2) / 2, cy = (t.box.y1 + t.box.y2) / 2;
    // candidate chain lines parallel to the text, crossing its middle, within 2h of the text box
    let best = null;
    for (const l of lines) {
      if (vert ? Math.abs(l.a[0] - l.b[0]) > 0.5 : Math.abs(l.a[1] - l.b[1]) > 0.5) continue;
      const c = vert ? l.a[0] : l.a[1], lo = Math.min(vert ? l.a[1] : l.a[0], vert ? l.b[1] : l.b[0]), hi = Math.max(vert ? l.a[1] : l.a[0], vert ? l.b[1] : l.b[0]);
      const m = vert ? cy : cx;
      if (m < lo - 1 || m > hi + 1) continue;
      const d = vert ? Math.min(Math.abs(c - t.box.x1), Math.abs(c - t.box.x2)) : Math.min(Math.abs(c - t.box.y1), Math.abs(c - t.box.y2));
      if (d > 2 * h) continue;
      const pts = points.filter(p => Math.abs((vert ? p.at[0] : p.at[1]) - c) < 0.5 && (vert ? p.at[1] : p.at[0]) >= lo - 0.5 && (vert ? p.at[1] : p.at[0]) <= hi + 0.5).map(p => vert ? p.at[1] : p.at[0]).sort((p, q) => p - q);
      if (pts.length < 2) continue;
      if (!best || d < best.d) best = { d, pts, m };
    }
    total++;
    if (!best) { bad.push(`dimension "${t.text}" has no chain with points`); continue; }
    const i = best.pts.findIndex(p => p > best.m), gap = i > 0 ? best.pts[i] - best.pts[i - 1] : NaN;
    if (!(Math.abs(gap - val) < 1)) bad.push(`dimension "${t.text}" but chain gap ${round(gap, 10)}`);
  }
  return { total, bad };
}

export const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
export const hasText = (items, re, layer) => items.some(i => i.kind === 'text' && (!layer || i.layer === layer) && (re instanceof RegExp ? re.test(i.text) : i.text === re));
export const horizontals = (items, layer, minLen = 0) => items.filter(i => i.kind === 'line' && (!layer || i.layer === layer) && Math.abs(i.a[1] - i.b[1]) < 0.5 && Math.abs(i.a[0] - i.b[0]) >= minLen);
export const verticals = (items, layer, minLen = 0) => items.filter(i => i.kind === 'line' && (!layer || i.layer === layer) && Math.abs(i.a[0] - i.b[0]) < 0.5 && Math.abs(i.a[1] - i.b[1]) >= minLen);
