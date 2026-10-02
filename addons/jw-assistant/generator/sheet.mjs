// Shared drafting kit for the drawing-set generators (elevation / section / foundation).
// A Sheet collects primitives in model mm for one JWW group; newSheetDocument() builds an empty JWW from a
// per-drawing-type header template (generator/header-template-*.json, office JWF-equivalent numbers only) and
// emit() converts primitives into codec entities. The plan generator (draw-plan.mjs) keeps its own copy.
import { readFileSync } from 'node:fs';
import { createJww, encodeJww, JwwEntity } from '../native/codec/jww-codec.mjs';
import { makeEntity, textLength } from '../native/codec/jww-ops.mjs';

export const PAPER = { w: 420, h: 297, frame: [-200, -138.5, 200, 138.5], title: 18, area: [-196, -119, 196, 137] };
const templates = new Map();
export function headerTemplate(kind) {
  if (!templates.has(kind)) templates.set(kind, JSON.parse(readFileSync(new URL(`./header-template-${kind}.json`, import.meta.url), 'utf8')).header);
  return templates.get(kind);
}
/** Text style table (paper mm) of a header template: {h[style], w[style], sp[style]} with style 1..10. */
export function styleTable(kind) {
  const h = headerTemplate(kind);
  return { h: [0, ...h.m_adMojiY], w: [0, ...h.m_adMojiX], sp: [0, ...h.m_adMojiD] };
}
export const layerNames = () => Array.from({ length: 16 }, (_, g) => Array.from({ length: 16 }, (_, l) =>
  ({ 8: 'ハッチ', 11: '色塗', 13: '文字', 14: '寸法', 15: '補助線' })[l] ?? `${g.toString(16).toUpperCase()}-${l.toString(16).toUpperCase()}`));

/** Primitive collector in model mm for one group (scale = 1/n of that group). */
export class Sheet {
  constructor(scale, styles) { this.scale = scale; this.styles = styles; this.items = []; }
  textLen(text, style, size) { return size ? textLength(text, size.w ?? size.h, size.sp ?? 0) : textLength(text, this.styles.w[style], this.styles.sp[style]); }
  textH(style, size) { return size ? size.h : this.styles.h[style]; }
  line(layer, pen, a, b) { if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.05) this.items.push({ k: 'line', layer, pen, a: [...a], b: [...b] }); }
  poly(layer, pen, pts, close = false) { for (let i = 0; i + 1 < pts.length; i++) this.line(layer, pen, pts[i], pts[i + 1]); if (close && pts.length > 2) this.line(layer, pen, pts.at(-1), pts[0]); }
  rect(layer, pen, x1, y1, x2, y2) { this.poly(layer, pen, [[x1, y1], [x2, y1], [x2, y2], [x1, y2]], true); }
  arc(layer, pen, c, r, start = 0, sweep = 360, { flat = 1, tilt = 0 } = {}) { this.items.push({ k: 'arc', layer, pen, c: [...c], r, start, sweep, flat, tilt }); }
  /** Text with its baseline-left corner at `at` (model mm). size = {h, w, sp} paper mm overrides the style table. */
  text(layer, at, text, style, { angle = 0, color = 2, size = null } = {}) { this.items.push({ k: 'text', layer, at: [...at], text: String(text), style, angle, color, size }); }
  /** Text anchored by alignment: ax 0=left .5=centre 1=right, ay 0=bottom .5=middle 1=top. Returns model bbox. */
  atext(layer, p, text, style, { ax = 0.5, ay = 0.5, angle = 0, size = null, color = 2 } = {}) {
    const l = this.textLen(String(text), style, size) * this.scale, h = this.textH(style, size) * this.scale;
    if (angle === 90) {
      const at = [p[0] + h * (1 - ay), p[1] - l * ax];          // rotated: text runs up, baseline on the right
      this.text(layer, at, text, style, { angle, size, color });
      return { x1: at[0] - h, y1: at[1], x2: at[0], y2: at[1] + l };
    }
    const at = [p[0] - l * ax, p[1] - h * ay];
    this.text(layer, at, text, style, { angle, size, color });
    return { x1: at[0], y1: at[1], x2: at[0] + l, y2: at[1] + h };
  }
  point(layer, at) { this.items.push({ k: 'point', layer, at: [...at] }); }
  solid(layer, pts, rgb = 0xffffff) { this.items.push({ k: 'solid', layer, pts: pts.map(p => [...p]), rgb }); }
  textBox(item) {
    const l = this.textLen(item.text, item.style, item.size) * this.scale, h = this.textH(item.style, item.size) * this.scale;
    return item.angle === 90 ? { x1: item.at[0] - h, y1: item.at[1], x2: item.at[0], y2: item.at[1] + l } : { x1: item.at[0], y1: item.at[1], x2: item.at[0] + l, y2: item.at[1] + h };
  }
  bbox(filter = () => true) {
    let b = null;
    const grow = p => { b = b ? [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])] : [p[0], p[1], p[0], p[1]]; };
    for (const it of this.items) {
      if (!filter(it)) continue;
      if (it.k === 'line') { grow(it.a); grow(it.b); }
      else if (it.k === 'arc') { grow([it.c[0] - it.r, it.c[1] - it.r]); grow([it.c[0] + it.r, it.c[1] + it.r]); }
      else if (it.k === 'text') { const r = this.textBox(it); grow([r.x1, r.y1]); grow([r.x2, r.y2]); }
      else if (it.k === 'point') grow(it.at);
      else if (it.k === 'solid') it.pts.forEach(grow);
    }
    return b;
  }
  /** Move every primitive by d (model mm). */
  translate(d, from = 0) {
    const T = p => [p[0] + d[0], p[1] + d[1]];
    for (const it of this.items.slice(from)) {
      if (it.k === 'line') { it.a = T(it.a); it.b = T(it.b); } else if (it.k === 'arc') it.c = T(it.c);
      else if (it.k === 'text' || it.k === 'point') it.at = T(it.at); else if (it.k === 'solid') it.pts = it.pts.map(T);
    }
  }
}

/** Empty JWW for one drawing type. groups = {g: {name, scale}}; every layer visible + editable. */
export function newSheetDocument(kind, groups, memo) {
  const doc = createJww({ version: 700 });
  for (const [k, v] of Object.entries(headerTemplate(kind))) doc.header[k] = Array.isArray(v) ? structuredClone(v) : v;
  const h = doc.header, names = layerNames();
  h.m_strMemo = memo ?? '';
  for (let g = 0; g < 16; g++) {
    for (let l = 0; l < 16; l++) { h.m_aStrLayName[g][l] = names[g][l]; h.m_aanLay[g][l] = 2; h.m_aanLayProtect[g][l] = 0; }
    h.m_aStrGLayName[g] = ''; h.m_adScale[g] = 1; h.m_anGLay[g] = 2; h.m_anGLayProtect[g] = 0;
  }
  h.m_aStrGLayName[0] = '図枠';
  for (const [g, { name, scale }] of Object.entries(groups)) { h.m_aStrGLayName[g] = name; h.m_adScale[g] = scale; }
  h.m_nWriteGLay = Number(Object.keys(groups).find(g => g !== '0') ?? 1);
  h.m_dBairitsu = 1; h.m_dHanniBairitsu = 1; h.m_DPGenten_x = 0; h.m_DPGenten_y = 0;
  if (Array.isArray(h.m_dZoomJumpBairitsu)) h.m_dZoomJumpBairitsu.fill(1);
  h.m_nZumen = 3;                                    // A3
  return doc;
}

/** Append a sheet's primitives to doc. shift = model-mm offset subtracted before scaling into file (paper) units. */
export function emit(doc, sheet, shift = [0, 0]) {
  const M = p => [p[0] - shift[0], p[1] - shift[1]];
  for (const it of sheet.items) {
    const id = `e${doc.entities.length}`, layer = it.layer, pen = it.pen ? { color: it.pen.color, style: it.pen.style, width: 0 } : undefined;
    const [g] = layer.split(':').map(v => parseInt(v, 16)), s = doc.header.m_adScale[g];
    let e;
    if (it.k === 'line') e = makeEntity(doc, { kind: 'line', layer, pen, start: M(it.a), end: M(it.b) }, id);
    else if (it.k === 'arc') e = makeEntity(doc, { kind: 'arc', layer, pen, center: M(it.c), radius: it.r, startAngle: it.start, sweepAngle: it.sweep, tilt: it.tilt, flatness: it.flat }, id);
    else if (it.k === 'text') e = makeEntity(doc, { kind: 'text', layer, at: M(it.at), text: it.text, angle: it.angle, color: it.color,
      ...(it.size ? { style: 0, height: it.size.h, width: it.size.w ?? it.size.h, spacing: it.size.sp ?? 0 } : { style: it.style }) }, id);
    else if (it.k === 'point') e = makeEntity(doc, { kind: 'point', layer, pen: { color: 1, style: 1, width: 0 }, at: M(it.at) }, id);
    else if (it.k === 'solid') {
      const l = parseInt(layer.split(':')[1], 16), f = it.pts.map(p => M(p).map(v => v / s));
      while (f.length < 4) f.push(f.at(-1));
      e = new JwwEntity(id, 'CDataSolid', { m_lGroup: 0, m_nPenStyle: 1, m_nPenColor: 10, m_nPenWidth: 0, m_nLayer: l, m_nGLayer: g, m_sFlg: 0,
        m_start_x: f[0][0], m_start_y: f[0][1], m_end_x: f[1][0], m_end_y: f[1][1], m_DPoint2_x: f[2][0], m_DPoint2_y: f[2][1], m_DPoint3_x: f[3][0], m_DPoint3_y: f[3][1], m_Color: it.rgb });
    }
    doc.entities.push(e);
  }
}

/** Neutral A3 frame + title strip on group 0 (paper mm). No client data. */
export function drawFrame(styles, title) {
  const F = new Sheet(1, styles), [x1, y1, x2, y2] = PAPER.frame, ty = y1 + PAPER.title, pen = { color: 2, style: 1 }, thin = { color: 1, style: 1 };
  F.rect('0:0', pen, x1, y1, x2, y2);
  F.line('0:0', pen, [x1, ty], [x2, ty]);
  const cells = [[x1, -40, '工事名', title.project, 4], [-40, 60, '図面名', title.drawing, 4], [60, 105, '縮尺', `${title.scale} (A3)`, 3], [105, 155, '日付', title.date || '-', 3], [155, x2, '図番', title.sheet, 4]];
  for (const [a, b, cap, val, st] of cells) {
    if (a > x1) F.line('0:0', thin, [a, y1], [a, ty]);
    F.text('0:D', [a + 1.5, ty - 3.2], cap, 1);
    F.atext('0:D', [(a + b) / 2, y1 + 4.5], val, st, { ax: 0.5, ay: 0 });
  }
  return F;
}

/** Encode + basic layout facts. */
export function finish(doc) { return encodeJww(doc); }
export const fmt = n => Math.round(n).toLocaleString('en-US');
