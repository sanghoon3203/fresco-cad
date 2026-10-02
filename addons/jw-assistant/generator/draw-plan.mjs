// drawPlan(spec) -> JWW bytes. Builds a NEW document from zero with the pure-JS codec and draws every element
// as primitives on the office layers/pens (knowledge/office-drafting-rules.json). Coordinates in the spec are
// model mm (X1/Y1 grid origin, x right, y up); group 1 is 1/50, group 0 is the A3 frame at 1/1.
import { readFileSync } from 'node:fs';
import { createJww, encodeJww, JwwEntity } from '../native/codec/jww-codec.mjs';
import { makeEntity, textLength } from '../native/codec/jww-ops.mjs';
import { normalizeSpec, onModule } from './spec.mjs';
import { buildModel, wallCuts, EXT, INT, COLUMN, WINDOW_INNER_STEP } from './model.mjs';
import { SYMBOLS, itemTransform } from './symbols.mjs';
import {
  sub, dot, unit, round, offsetPolygon, polygonEdges, gridBoundary, inRect, frameToWorld, frameRect, subtractIntervals,
  clipLineToRings, lineRectInterval, fmtThousands, pointInPolygon, pointOnSegment
} from './geometry.mjs';

const HEADER = JSON.parse(readFileSync(new URL('./header-template.json', import.meta.url), 'utf8')).header;
export const SCALE = 50;
export const PAPER = { w: 420, h: 297, frame: [-200, -138.5, 200, 138.5], title: 18, area: [-196, -119, 196, 137] };
// Text styles of the office header (paper mm): 1:2.1 2:2.5 3:3.2 4:4 5:5 6:6 7:2.2 8:3.0 9:3.5 10:2.8
export const TEXT = { roomName: 8, area: 7, dim: 8, grid: 9, tag: 2, note: 2, label: 2 };
const STYLE_H = [0, 2.1, 2.5, 3.2, 4, 5, 6, 2.2, 3, 3.5, 2.8], STYLE_SP = [0, 0, 0, 0, 0, 0, 0, 0, 0, -0.2, 0];
export const PEN = {
  aux: { color: 3, style: 2 }, face: { color: 2, style: 1 }, siding: { color: 4, style: 1 }, column: { color: 2, style: 1 }, columnX: { color: 1, style: 1 },
  core: { color: 4, style: 1 }, batten: { color: 1, style: 1 }, open1: { color: 1, style: 1 }, open2: { color: 2, style: 1 }, open4: { color: 4, style: 1 },
  leaf: { color: 5, style: 1 }, leafOpen: { color: 5, style: 2 }, equip: { color: 7, style: 1 }, furn: { color: 4, style: 2 }, hatch: { color: 4, style: 1 },
  gridLine: { color: 7, style: 5 }, bubble: { color: 1, style: 1 }, insul: { color: 8, style: 1 }, addInsul: { color: 112, style: 1 },
  label: { color: 1, style: 1 }, dim: { color: 1, style: 1 }, dimExt: { color: 4, style: 5 }, symbol: { color: 1, style: 1 }, frame: { color: 2, style: 1 }, frameThin: { color: 1, style: 1 }
};
export const layerNames = () => {
  const names = [];
  for (let g = 0; g < 16; g++) { const h = g.toString(16).toUpperCase(); names.push(Array.from({ length: 16 }, (_, l) => ({ 8: 'ハッチ', 11: '色塗', 13: '文字', 14: '寸法', 15: '補助線' })[l] ?? `${h}-${l.toString(16).toUpperCase()}`)); }
  return names;
};
const textLen = (text, style) => textLength(text, STYLE_H[style], STYLE_SP[style]);   // paper mm

/** Primitive collector in spec (model mm) coordinates for group 1. */
class Sheet {
  constructor() { this.items = []; }
  line(layer, pen, a, b) { if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.05) this.items.push({ k: 'line', layer, pen, a, b }); }
  poly(layer, pen, pts, close = false) { for (let i = 0; i + 1 < pts.length; i++) this.line(layer, pen, pts[i], pts[i + 1]); if (close) this.line(layer, pen, pts.at(-1), pts[0]); }
  rect(layer, pen, x1, y1, x2, y2) { this.poly(layer, pen, [[x1, y1], [x2, y1], [x2, y2], [x1, y2]], true); }
  arc(layer, pen, c, r, start, sweep, { flat = 1, tilt = 0 } = {}) { this.items.push({ k: 'arc', layer, pen, c, r, start, sweep, flat, tilt }); }
  text(layer, at, text, style, { angle = 0, color = 2 } = {}) { this.items.push({ k: 'text', layer, at, text, style, angle, color }); }
  /** Centred text at c (model mm). Returns its model bbox. */
  ctext(layer, c, text, style, opt = {}) {
    const l = textLen(text, style) * SCALE, h = STYLE_H[style] * SCALE;
    if (opt.angle === 90) { this.text(layer, [c[0] + h / 2, c[1] - l / 2], text, style, opt); return { x1: c[0] - h / 2, y1: c[1] - l / 2, x2: c[0] + h / 2, y2: c[1] + l / 2 }; }
    this.text(layer, [c[0] - l / 2, c[1] - h / 2], text, style, opt); return { x1: c[0] - l / 2, y1: c[1] - h / 2, x2: c[0] + l / 2, y2: c[1] + h / 2 };
  }
  point(layer, at) { this.items.push({ k: 'point', layer, at }); }
  solid(layer, pts, rgb = 0xffffff) { this.items.push({ k: 'solid', layer, pts, rgb }); }
  bbox() {
    let b = null;
    const grow = p => { b = b ? [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])] : [p[0], p[1], p[0], p[1]]; };
    for (const it of this.items) {
      if (it.k === 'line') { grow(it.a); grow(it.b); }
      else if (it.k === 'arc') { grow([it.c[0] - it.r, it.c[1] - it.r]); grow([it.c[0] + it.r, it.c[1] + it.r]); }
      else if (it.k === 'text') { grow(it.at); const l = textLen(it.text, it.style) * SCALE; grow(it.angle === 90 ? [it.at[0] - STYLE_H[it.style] * SCALE, it.at[1] + l] : [it.at[0] + l, it.at[1] + STYLE_H[it.style] * SCALE]); }
      else if (it.k === 'point') grow(it.at);
      else if (it.k === 'solid') it.pts.forEach(grow);
    }
    return b;
  }
}

// ---------- drawing steps ----------
function drawAuxGrid(S, m) {
  const xs = m.poly.map(p => p[0]), ys = m.poly.map(p => p[1]), [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // 910 grid lines plus the 455 half lines actually used by walls / jamb columns (as in the practice drawing).
  const half = vals => vals.slice(0, -1).map((g, i) => (g + vals[i + 1]) / 2);
  const used = m.walls.filter(w => w.kind === 'int').flatMap(w => [w.a, w.b]).concat(m.columns.map(c => c.at));
  const hx = half(m.spec.grid.x).filter(x => used.some(p => Math.abs(p[0] - x) < 0.5)), hy = half(m.spec.grid.y).filter(y => used.some(p => Math.abs(p[1] - y) < 0.5));
  // clipped to the footprint (slightly grown so lines on the outline survive) - no aux grid in an L-plan courtyard
  const ring = offsetPolygon(m.poly, -1), clip = (p, d) => clipLineToRings(p, d, [ring]).map(([t0, t1]) => [Math.max(t0, -1e9), t1]);
  for (const x of [...m.spec.grid.x, ...hx]) if (x >= x0 - 0.5 && x <= x1 + 0.5) for (const [t0, t1] of clip([x, y0 - 10], [0, 1])) S.line('1:0', PEN.aux, [x, Math.max(y0, y0 - 10 + t0)], [x, Math.min(y1, y0 - 10 + t1)]);
  for (const y of [...m.spec.grid.y, ...hy]) if (y >= y0 - 0.5 && y <= y1 + 0.5) for (const [t0, t1] of clip([x0 - 10, y], [1, 0])) S.line('1:0', PEN.aux, [Math.max(x0, x0 - 10 + t0), y], [Math.min(x1, x0 - 10 + t1), y]);
}

function drawWalls(S, m) {
  // Thick finish faces = boundary of the wall-body union (clean corners/T-junctions); opening jamb edges dropped.
  const segs = gridBoundary(m.bodies, ([a, b]) => { const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; return !m.dropBoxes.some(r => inRect(r, mid)); });
  for (const [a, b] of segs) S.line('1:1', PEN.face, a, b);
  // Exterior assembly lines on offset polygons, broken at openings / columns.
  const ext = m.walls.filter(w => w.kind === 'ext');
  const offsetLine = (d, layer, pen, cutsFor) => {
    const op = offsetPolygon(m.poly, d);
    ext.forEach((w, i) => {
      const f = w.frame, pa = op[i], pb = op[(i + 1) % op.length], ua = dot(sub(pa, f.o), f.t), ub = dot(sub(pb, f.o), f.t);
      for (const [u0, u1] of subtractIntervals(ua, ub, cutsFor(w))) S.line(layer, pen, frameToWorld(f, u0, d), frameToWorld(f, u1, d));
    });
  };
  const openCuts = (w, pad) => m.openings.filter(o => o.wall === w.id).map(o => [o.r0 - pad, o.r1 + pad]);
  offsetLine(EXT.siding, '1:1', PEN.siding, w => openCuts(w, 0));
  offsetLine(EXT.battenOut, '1:4', PEN.batten, w => openCuts(w, 45));
  offsetLine(EXT.battenIn, '1:4', PEN.batten, w => openCuts(w, 45));
  offsetLine(EXT.coreOut, '1:3', PEN.core, w => wallCuts(m, w));
  offsetLine(EXT.coreIn, '1:3', PEN.core, w => wallCuts(m, w));
  for (const w of m.walls.filter(x => x.kind === 'int')) for (const v of [-INT.core, INT.core])
    for (const [u0, u1] of subtractIntervals(0, w.frame.length, wallCuts(m, w))) S.line('1:3', PEN.core, frameToWorld(w.frame, u0, v), frameToWorld(w.frame, u1, v));
}

function drawAddedInsulation(S, m) {   // 1:C cross hatch ±45°, 30 mm apart, inside the -152..-62 band
  const ringOut = offsetPolygon(m.poly, EXT.battenOut), ringIn = offsetPolygon(m.poly, EXT.battenIn);
  const stops = m.openings.filter(o => o.wallKind === 'ext').map(o => frameRect(o.frame, o.r0 - 45, o.r1 + 45, EXT.battenOut - 1, EXT.battenIn + 1));
  const xs = ringOut.map(p => p[0]), ys = ringOut.map(p => p[1]), [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const step = 30 * Math.SQRT2;
  for (const [d, cLo, cHi, base] of [[[1, 1], x0 - y1, x1 - y0, x0 - y0], [[1, -1], x0 + y0, x1 + y1, x0 + y0]]) {
    const dir = unit(d);
    for (let c = base + Math.floor((cLo - base) / step) * step; c <= cHi + step; c += step) {
      const p = d[1] > 0 ? [c, 0] : [c, 0];        // x - y = c  or  x + y = c, both pass (c, 0)
      for (const [t0, t1] of clipLineToRings(p, dir, [ringOut, ringIn])) {
        const cuts = stops.map(r => lineRectInterval(p, dir, r)).filter(Boolean);
        for (const [a, b] of subtractIntervals(t0, t1, cuts, 1)) S.line('1:C', PEN.addInsul, [p[0] + dir[0] * a, p[1] + dir[1] * a], [p[0] + dir[0] * b, p[1] + dir[1] * b]);
      }
    }
  }
}

function drawInsulation(S, m) {        // 1:A pen 8 wave: vertices ±35 every 17.5, R17.5 end arcs (measured)
  for (const w of m.walls.filter(x => x.kind === 'ext')) {
    const f = w.frame;
    for (const [a, b] of subtractIntervals(0, f.length, wallCuts(m, w))) {
      const N = Math.floor((b - a) / 17.5 + 1e-6);
      if (N < 2) continue;
      const P = k => frameToWorld(f, a + 17.5 * k, k % 2 ? 35 : -35);
      for (let k = 0; k < N; k++) S.line('1:A', PEN.insul, P(k), P(k + 1));
      const back = Math.atan2(-f.t[1], -f.t[0]) * 180 / Math.PI;
      for (let k = 0; k + 2 <= N; k++) { const s = k % 2 ? 1 : -1; S.arc('1:A', PEN.insul, frameToWorld(f, a + 17.5 * (k + 1), 35 * s), 17.5, back, -s * 180); }
    }
  }
}

function drawColumns(S, m) {
  const h = COLUMN / 2;
  for (const { at: [x, y] } of m.columns) {
    const sq = [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]];
    S.solid('1:2', sq);
    S.poly('1:2', PEN.column, sq, true);
    S.line('1:2', PEN.columnX, sq[0], sq[2]); S.line('1:2', PEN.columnX, sq[3], sq[1]);
  }
}

function jambBoxes(S, o, depth = 24) {
  const f = o.frame, v0 = o.wallKind === 'int' ? o.vout - 12.5 : o.vout, v1 = o.vin + 12.5;
  for (const [u0, u1] of [[o.r0, o.r0 + depth], [o.r1 - depth, o.r1]]) S.poly('1:5', PEN.open2, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => frameToWorld(f, u, v)), true);
}
function battenEnds(S, o) {
  const f = o.frame, W = (u, v) => frameToWorld(f, u, v);
  for (const [u0, u1] of [[o.r0 - 45, o.r0], [o.r1, o.r1 + 45]]) {
    S.poly('1:5', PEN.leaf, [W(u0, EXT.battenOut), W(u1, EXT.battenOut), W(u1, EXT.battenIn), W(u0, EXT.battenIn)], true);
    S.line('1:5', PEN.open1, W(u0, EXT.battenOut), W(u1, EXT.battenIn));
  }
}
function drawOpenings(S, m) {
  for (const o of m.openings) {
    const f = o.frame, W = (u, v) => frameToWorld(f, u, v), L = (pen, u0, v0, u1, v1) => S.line('1:5', pen, W(u0, v0), W(u1, v1));
    if (o.type === 'window-sliding') {
      const a = o.r0 + WINDOW_INNER_STEP, b = o.r1 - WINDOW_INNER_STEP;
      L(PEN.open2, a, -102, a, o.vin); L(PEN.open2, b, -102, b, o.vin);                       // inner trim jambs
      L(PEN.open1, a, o.vin + 15, b, o.vin + 15); L(PEN.open1, a, o.vin, a, o.vin + 15); L(PEN.open1, b, o.vin, b, o.vin + 15); // window board
      L(PEN.open1, o.r0, -217, o.r0, -87); L(PEN.open1, o.r1, -217, o.r1, -87);              // frame ends
      L(PEN.open1, o.r0, -87, a, -87); L(PEN.open1, b, -87, o.r1, -87);
      L(PEN.open1, a, -102, b, -102); L(PEN.open1, o.r0, -217, o.r1, -217);                  // frame inner / outer sill
      for (const v of [-157, -136.5, -116]) L(PEN.open1, o.r0 + 40, v, o.r1 - 40, v);          // two sashes (引違い)
      L(PEN.open4, o.r0 + 40, -157, o.r0 + 40, -116); L(PEN.open4, o.r1 - 40, -157, o.r1 - 40, -116);
      L(PEN.open4, (o.r0 + o.r1) / 2, -157, (o.r0 + o.r1) / 2, -116);                          // meeting stile
      battenEnds(S, o);
      continue;
    }
    jambBoxes(S, o);
    if (o.wallKind === 'ext') battenEnds(S, o);
    if (o.type === 'door-swing' || o.type === 'entrance-door') {
      const s = o.swingSign, Fs = s > 0 ? o.vin : o.vout, Fo = s > 0 ? o.vout : o.vin, thick = o.type === 'entrance-door' ? 45 : 33;
      const uh = o.hingeAtR0 ? o.r0 + 24 : o.r1 - 24, Lf = o.leaf, ue = uh + (o.hingeAtR0 ? Lf : -Lf), uf = o.hingeAtR0 ? o.r1 - 24 : o.r0 + 24;
      const vf = Fs + s * 2.5, vb = vf - s * thick;
      if (Math.abs(uf - ue) > 30) { S.poly('1:5', PEN.open1, [W(ue, vf), W(uf, vf), W(uf, vf - s * 40), W(ue, vf - s * 40)], true); L(PEN.open4, ue, vf - s * 20, uf, vf - s * 20); }   // 袖FIX
      L(PEN.leaf, uh, vf, ue, vf); L(PEN.leaf, uh, vb, ue, vb);                                 // leaf (closed)
      const hinge = W(uh, vf), closed = sub(W(ue, vf), hinge), open = sub(W(uh, vf + s * Lf), hinge);
      const a0 = Math.atan2(closed[1], closed[0]) * 180 / Math.PI, cross = closed[0] * open[1] - closed[1] * open[0];
      S.arc('1:5', PEN.open1, hinge, Lf, a0, cross > 0 ? 90 : -90);                            // swing
      L(PEN.open2, uh, Fo - s * 12.5, uh, vf + s * Lf);                                         // open-leaf line
      if (o.type === 'entrance-door') L(PEN.open1, o.r0, o.vout, o.r1, o.vout);                // threshold
    } else if (o.type === 'door-sliding-double') {                                              // 引違い戸: two leaves on two tracks
      const mid = (o.r0 + o.r1) / 2;
      S.poly('1:5', PEN.leaf, [W(o.r0 + 24, -30), W(mid + 20, -30), W(mid + 20, 0), W(o.r0 + 24, 0)], true);
      S.poly('1:5', PEN.leaf, [W(mid - 20, 0), W(o.r1 - 24, 0), W(o.r1 - 24, 30), W(mid - 20, 30)], true);
    } else if (o.type === 'door-sliding') {
      const s = o.swingSign || 1, v0 = s * 3.5, v1 = s * 33.5, Lf = o.r1 - o.r0 - 48, sh = o.slideToR0 ? -Lf : Lf;
      S.poly('1:5', PEN.leaf, [W(o.r0 + 24, v0), W(o.r1 - 24, v0), W(o.r1 - 24, v1), W(o.r0 + 24, v1)], true);
      S.poly('1:5', PEN.leafOpen, [W(o.r0 + 24 + sh, v0), W(o.r1 - 24 + sh, v0), W(o.r1 - 24 + sh, v1), W(o.r0 + 24 + sh, v1)], true);
    }
  }
}

function drawTags(S, m) {              // window / entrance tags outside the wall (1:D)
  const out = [], extLines = predictedExtLines(m);
  const clash = r => extLines.some(l => segHits({ a: l[0], b: l[1] }, r)) || out.some(t => t.rect.x1 < r.x2 && r.x1 < t.rect.x2 && t.rect.y1 < r.y2 && r.y1 < t.rect.y2);
  for (const o of m.openings.filter(x => x.wallKind === 'ext' && (x.type === 'window-sliding' || x.type === 'entrance-door'))) {
    const lines = [o.id, o.tag ?? `${Math.round(o.clear)}${o.height ? `×${o.height}` : ''}`];
    const w = Math.max(...lines.map(t => textLen(t, TEXT.tag))) * SCALE + 60, h = lines.length * STYLE_H[TEXT.tag] * SCALE + 90;
    const vert = Math.abs(o.frame.n[0]) > 0.5, along = vert ? w : h, alongU = vert ? h : w;
    // outward entrance door: tag beside the latch-side jamb so it stays clear of the swing
    let u = o.u, v = EXT.out - 260 - along / 2;
    if (o.type === 'entrance-door' && o.swingSign < 0) {      // nearest column gap (= between extension lines) that clears the swing
      const w = m.walls.find(x => x.id === o.wall), us = m.columns.filter(c => pointOnSegment(c.at, w.a, w.b, 1)).map(c => dot(sub(c.at, w.frame.o), w.frame.t)).sort((p, q) => p - q);
      const gaps = us.slice(1).map((b2, i) => [us[i], b2]).filter(([g0, g1]) => g1 - g0 - COLUMN >= alongU + 60 && (g1 <= o.u - o.width / 2 + 1 || g0 >= o.u + o.width / 2 - 1)
        && !m.openings.some(x => x !== o && x.wall === o.wall && x.u + x.width / 2 > g0 + 1 && x.u - x.width / 2 < g1 - 1));   // keep off other tags
      const best = gaps.sort((p, q) => Math.abs((p[0] + p[1]) / 2 - o.u) - Math.abs((q[0] + q[1]) / 2 - o.u))[0];
      if (best) u = (best[0] + best[1]) / 2; else v -= o.clear - 48 + 150;
    }
    const rectAt = q => { const p = frameToWorld(o.frame, q, v); return { x1: p[0] - w / 2 - 20, y1: p[1] - h / 2 - 20, x2: p[0] + w / 2 + 20, y2: p[1] + h / 2 + 20 }; };
    const du = [0, 150, -150, 300, -300, 450, -450, 600, -600].find(d => !clash(rectAt(u + d)));
    const c = frameToWorld(o.frame, u + (du ?? 0), v);
    S.solid('1:B', [[c[0] - w / 2, c[1] - h / 2], [c[0] + w / 2, c[1] - h / 2], [c[0] + w / 2, c[1] + h / 2], [c[0] - w / 2, c[1] + h / 2]]);
    S.rect('1:D', PEN.label, c[0] - w / 2, c[1] - h / 2, c[0] + w / 2, c[1] + h / 2);
    S.line('1:D', PEN.label, [c[0] - w / 2, c[1]], [c[0] + w / 2, c[1]]);
    S.ctext('1:D', [c[0], c[1] + h / 4], lines[0], TEXT.tag); S.ctext('1:D', [c[0], c[1] - h / 4], lines[1], TEXT.tag);
    out.push({ id: o.id, rect: { x1: c[0] - w / 2, y1: c[1] - h / 2, x2: c[0] + w / 2, y2: c[1] + h / 2 } });
  }
  return out;
}

function drawItems(S, m) {
  for (const it of m.items) {
    const def = SYMBOLS[it.type], T = itemTransform(it.at, it.rotation), equip = def.role === 'equipment';
    const layer = equip ? '1:6' : '1:7', base = equip ? PEN.equip : PEN.furn;
    const pen = o => (o?.style ? { ...base, style: equip ? base.style : o.style } : base);
    const c = {
      line: (a, b, o) => S.line(layer, pen(o), T.apply(a), T.apply(b)),
      rect: (x1, y1, x2, y2, o) => S.poly(layer, pen(o), [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(T.apply), true),
      circle: (p, r, o) => S.arc(layer, pen(o), T.apply(p), r, 0, 360),
      arc: (p, r, st, sw, o) => S.arc(layer, pen(o), T.apply(p), r, st + it.rotation, sw),
      ellipse: (p, rx, ry, o) => (ry > rx ? S.arc(layer, pen(o), T.apply(p), ry, 0, 360, { flat: rx / ry, tilt: 90 + it.rotation }) : S.arc(layer, pen(o), T.apply(p), rx, 0, 360, { flat: ry / rx, tilt: it.rotation }))
    };
    def.draw(c, it.size);
    // item labels only when they fit inside the footprint width (a label hanging onto walls reads as noise)
    if (it.label && (def.labelOffset || textLen(it.label, TEXT.label) * SCALE <= it.rect.x2 - it.rect.x1 - 40)) S.ctext('1:D', def.labelOffset ? T.apply(def.labelOffset) : it.at, it.label, TEXT.label);
  }
}

function drawDoma(S, m) {              // 玄関土間: 300 tile hatch (1:8) + 框 line where the doma meets the floor
  for (const r of m.rooms.filter(x => x.doma && x.clear)) {
    const cb = r.clear.bbox, [dx1, dy1, dx2, dy2] = r.doma;
    const R = { x1: Math.max(cb.x1, Math.min(dx1, dx2)), y1: Math.max(cb.y1, Math.min(dy1, dy2)), x2: Math.min(cb.x2, Math.max(dx1, dx2)), y2: Math.min(cb.y2, Math.max(dy1, dy2)) };
    if (R.x2 - R.x1 < 100 || R.y2 - R.y1 < 100) continue;
    for (let x = R.x1 + 300; x < R.x2 - 1; x += 300) S.line('1:8', PEN.hatch, [x, R.y1], [x, R.y2]);
    for (let y = R.y1 + 300; y < R.y2 - 1; y += 300) S.line('1:8', PEN.hatch, [R.x1, y], [R.x2, y]);
    // a doma edge is a 框 only where free floor continues beyond it (not where it runs along a wall face)
    const freeBeyond = (a, b, out) => { let n = 0, k = 0; for (let t = 0.05; t < 1; t += 0.1, k++) { const p = [a[0] + (b[0] - a[0]) * t + out[0] * 30, a[1] + (b[1] - a[1]) * t + out[1] * 30], [i, j] = m.bodiesSolid.cellOf(p); if (i >= 0 && j >= 0 && !m.bodiesSolid.at(i, j) && pointInPolygon(p, m.inner)) n++; } return n > k / 2; };
    const edges = [[[R.x1, R.y1], [R.x1, R.y2], [-1, 0]], [[R.x2, R.y1], [R.x2, R.y2], [1, 0]], [[R.x1, R.y1], [R.x2, R.y1], [0, -1]], [[R.x1, R.y2], [R.x2, R.y2], [0, 1]]].map(([a, b, out]) => [freeBeyond(a, b, out), a, b]);
    for (const [inside, a, b] of edges) if (inside) { S.line('1:8', PEN.hatch, a, b); r.kamachi = [...(r.kamachi ?? []), [a, b]]; }
    if (r.kamachi?.length) { const [a, b] = r.kamachi[0], c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], vert = Math.abs(a[0] - b[0]) < 1;
      S.ctext('1:D', vert ? [c[0] + 220, c[1] - 450] : [c[0] + 450, c[1] + 160], '框', TEXT.note); }
    r.domaRect = R;
  }
}

function drawRoomLabels(S, m) {
  const out = [];
  for (const r of m.rooms.filter(x => x.label)) {
    const l = textLen(r.name, TEXT.roomName) * SCALE, w = l + 50, h = 3.6 * SCALE, [cx, cy] = r.at;
    const box = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
    S.solid('1:B', box);
    S.poly('1:D', PEN.label, box, true);
    S.text('1:D', [cx - l / 2, cy - 1.5 * SCALE], r.name, TEXT.roomName);
    const areaText = `${r.areaM2.toFixed(2)}㎡`, al = textLen(areaText, TEXT.area) * SCALE;
    S.text('1:D', [cx - al / 2, cy - 4.8 * SCALE], areaText, TEXT.area);
    out.push({ name: r.name, box: { x1: cx - w / 2, y1: cy - 4.8 * SCALE, x2: cx + w / 2, y2: cy + h / 2 } });
  }
  return out;
}

/** Dimension tiers per side. Returns {tiers: {side: [[values...]]}, bubbleBase: {side: offset}}. */
const sideInfo = side => ({ horiz: side === 'S' || side === 'N', sgn: side === 'S' || side === 'W' ? -1 : 1 });
const extentOf = poly => { const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]); return { S: Math.min(...ys), N: Math.max(...ys), W: Math.min(...xs), E: Math.max(...xs) }; };
/** Dimension break points per tier for one side: detail (jambs+walls+corners), structure, overall. */
function dimTiers(m, side) {
  const { poly } = m, { horiz } = sideInfo(side), coord = p => horiz ? p[0] : p[1];
  const facing = w => { const n = w.frame.n; return { S: n[1] > 0.5, N: n[1] < -0.5, W: n[0] > 0.5, E: n[0] < -0.5 }[side]; };
  const uniq = vals => [...new Set(vals.map(v => round(v, 10)))].sort((a, b) => a - b).filter((v, i, a) => !i || v - a[i - 1] > 1);
  const overall = uniq([Math.min(...poly.map(coord)), Math.max(...poly.map(coord))]);
  const struct = uniq([...poly.map(coord), ...m.walls.filter(w => w.kind === 'int').flatMap(w => [w.a, w.b]).filter(p => m.walls.some(e => e.kind === 'ext' && facing(e) && pointOnEdge(p, e))).map(coord)]);
  const jambs = m.openings.filter(o => o.wallKind === 'ext' && facing(m.walls.find(w => w.id === o.wall))).flatMap(o => o.jambs.map(coord));
  // 尺モジュール: the grid tier only carries 455-lattice points; off-module jambs get their own innermost opening-position tier
  const origin = horiz ? m.spec.grid.x[0] : m.spec.grid.y[0], onLat = v => onModule(v, origin);
  const grid = uniq([...struct, ...jambs.filter(onLat)]), opening = uniq([...grid, ...jambs]);
  const tiers = [];
  for (const t of [opening, grid, struct, overall]) if (t.length >= 2 && !tiers.some(x => x.join() === t.join())) tiers.push(t);
  if (tiers.length > 3) tiers.splice(tiers.indexOf(struct), 1);   // office practice: at most three tiers
  return tiers;
}
/** Predicted extension lines (world segments) so tags can stay off them. */
function predictedExtLines(m) {
  const out = [];
  for (const side of m.spec.dims.sides) {
    const { horiz, sgn } = sideInfo(side);
    const e = extentOf(m.poly)[side];
    for (const u of new Set(dimTiers(m, side).flat())) { let face = facadeAt(m.outer, horiz, u, sgn); if (Math.abs(face - (e + sgn * 185)) > 1000) face = e + sgn * 885; const a = face + sgn * 101, b = face + sgn * 1e6; out.push(horiz ? [[u, a], [u, b]] : [[a, u], [b, u]]); }
  }
  return out;
}
function drawDimensions(S, m, tags = []) {
  const { spec, outer } = m, ext = extentOf(m.poly), result = { tiers: {}, base: {} };
  for (const side of ['S', 'E', 'N', 'W']) {
    const { horiz, sgn } = sideInfo(side);
    if (!spec.dims.sides.includes(side)) { result.base[side] = ext[side] + sgn * spec.dims.first; continue; }
    const tiers = dimTiers(m, side);
    result.tiers[side] = tiers;
    const tagReach = Math.max(0, ...tags.map(t => side === 'S' ? ext.S - t.rect.y1 : side === 'N' ? t.rect.y2 - ext.N : side === 'W' ? ext.W - t.rect.x1 : t.rect.x2 - ext.E));
    const first = Math.max(spec.dims.first, tagReach + 250), at = k => ext[side] + sgn * (first + k * spec.dims.pitch);
    const P = (u, v) => horiz ? [u, v] : [v, u];
    const farthest = new Map();
    tiers.forEach((vals, k) => {
      const v = at(k);
      S.line('1:E', PEN.dim, P(vals[0], v), P(vals.at(-1), v));
      for (const u of vals) { S.point('1:E', P(u, v)); farthest.set(u, k); }
      for (let i = 1; i < vals.length; i++) {
        const txt = fmtThousands(vals[i] - vals[i - 1]), mid = (vals[i] + vals[i - 1]) / 2, l = textLen(txt, TEXT.dim) * SCALE;
        if (horiz) S.text('1:E', [mid - l / 2, v + 1.5], txt, TEXT.dim);
        else S.text('1:E', [v - 1.5, mid - l / 2], txt, TEXT.dim, { angle: 90 });
      }
    });
    for (const [u, k] of farthest) {                 // extension lines: solid to face-801, chain to face-101 (measured)
      const face = facadeAt(outer, horiz, u, sgn), v = at(k), mid = face + sgn * 801, near = face + sgn * 101;
      // recessed facade (courtyard of an L plan): stop at the building extent instead of crossing the courtyard
      if (Math.abs(face - (ext[side] + sgn * 185)) > 1000) { S.line('1:E', PEN.dim, P(u, v), P(u, ext[side] + sgn * 986)); continue; }
      if (Math.abs(v - face) > Math.abs(mid - face)) S.line('1:E', PEN.dim, P(u, v), P(u, mid));
      S.line('1:E', PEN.dimExt, P(u, Math.abs(v - face) > Math.abs(mid - face) ? mid : v), P(u, near));
    }
    result.base[side] = at(tiers.length - 1);
  }
  return result;
}
function segHits(l, r) { const d = sub(l.b, l.a), L = Math.hypot(d[0], d[1]); if (L < 1e-9) return false; const iv = lineRectInterval(l.a, [d[0] / L, d[1] / L], r); return !!iv && iv[1] > 0 && iv[0] < L; }
const pointOnEdge = (p, w) => { const d = sub(p, w.frame.o), u = dot(d, w.frame.t), v = dot(d, w.frame.n); return Math.abs(v) < 1 && u > -1 && u < w.frame.length + 1; };
function facadeAt(outer, horiz, u, sgn) {             // outermost wall face crossed by the projection line
  let best = null;
  polygonEdges(outer).forEach(([a, b]) => {
    if (horiz && Math.abs(a[1] - b[1]) < 1e-6 && u >= Math.min(a[0], b[0]) - 0.5 && u <= Math.max(a[0], b[0]) + 0.5) best = best === null ? a[1] : (sgn < 0 ? Math.min(best, a[1]) : Math.max(best, a[1]));
    if (!horiz && Math.abs(a[0] - b[0]) < 1e-6 && u >= Math.min(a[1], b[1]) - 0.5 && u <= Math.max(a[1], b[1]) + 0.5) best = best === null ? a[0] : (sgn < 0 ? Math.min(best, a[0]) : Math.max(best, a[0]));
  });
  return best;
}

function drawGridBubbles(S, m, base) {  // 通り芯 stub (1:A pen 7 chain) + R150 bubble (pen 1) + 3.5 mm label
  const { grid } = m.spec;
  for (const side of ['S', 'N', 'W', 'E']) {
    const horiz = side === 'S' || side === 'N', sgn = side === 'S' || side === 'W' ? -1 : 1, vals = horiz ? grid.x : grid.y, labels = horiz ? grid.xLabels : grid.yLabels;
    const v0 = base[side], v1 = v0 + sgn * 350, vc = v0 + sgn * 500, P = (u, v) => horiz ? [u, v] : [v, u];
    vals.forEach((u, i) => { S.line('1:A', PEN.gridLine, P(u, v0), P(u, v1)); S.arc('1:A', PEN.bubble, P(u, vc), 150, 0, 360); S.ctext('1:A', P(u, vc), labels[i], TEXT.grid); });
  }
}

function drawNorthArrow(S, at) {        // 1:9 simple north mark
  const r = 450, [x, y] = at;
  S.arc('1:9', PEN.symbol, at, r, 0, 360);
  S.poly('1:9', { color: 2, style: 1 }, [[x, y + r + 150], [x - 160, y - r * 0.6], [x, y - r * 0.25], [x + 160, y - r * 0.6]], true);
  S.line('1:9', PEN.symbol, [x, y - r], [x, y + r + 150]);
  S.ctext('1:9', [x, y + r + 330], 'N', 4);
}

// ---------- document assembly ----------
function newDocument() {
  const doc = createJww({ version: 700 });
  for (const [k, v] of Object.entries(HEADER)) doc.header[k] = Array.isArray(v) ? structuredClone(v) : v;
  const h = doc.header, names = layerNames();
  h.m_strMemo = '';
  for (let g = 0; g < 16; g++) { for (let l = 0; l < 16; l++) h.m_aStrLayName[g][l] = names[g][l]; h.m_aStrGLayName[g] = ''; h.m_adScale[g] = 1; }
  h.m_aStrGLayName[0] = '図枠'; h.m_aStrGLayName[1] = '平面詳細図'; h.m_adScale[1] = SCALE;
  h.m_dBairitsu = 1; h.m_dHanniBairitsu = 1; h.m_DPGenten_x = 0; h.m_DPGenten_y = 0;
  if (Array.isArray(h.m_dZoomJumpBairitsu)) h.m_dZoomJumpBairitsu.fill(1);
  h.m_nZumen = 3;                                    // A3
  return doc;
}
function toEntities(doc, items, group, shift) {
  const s = doc.header.m_adScale[group], M = p => [p[0] - shift[0], p[1] - shift[1]];
  for (const it of items) {
    const id = `e${doc.entities.length}`, layer = it.layer.startsWith('0:') ? it.layer : it.layer;
    let e;
    if (it.k === 'line') e = makeEntity(doc, { kind: 'line', layer, pen: { ...it.pen, width: 0 }, start: M(it.a), end: M(it.b) }, id);
    else if (it.k === 'arc') e = makeEntity(doc, { kind: 'arc', layer, pen: { ...it.pen, width: 0 }, center: M(it.c), radius: it.r, startAngle: it.start, sweepAngle: it.sweep, tilt: it.tilt, flatness: it.flat }, id);
    else if (it.k === 'text') e = makeEntity(doc, { kind: 'text', layer, at: M(it.at), text: it.text, style: it.style, angle: it.angle, color: it.color }, id);
    else if (it.k === 'point') e = makeEntity(doc, { kind: 'point', layer, pen: { color: 1, style: 1, width: 0 }, at: M(it.at) }, id);
    else if (it.k === 'solid') {
      const [g, l] = layer.split(':').map(v => parseInt(v, 16)), f = it.pts.map(p => M(p).map(v => v / s));
      e = new JwwEntity(id, 'CDataSolid', { m_lGroup: 0, m_nPenStyle: 1, m_nPenColor: 10, m_nPenWidth: 0, m_nLayer: l, m_nGLayer: g, m_sFlg: 0,
        m_start_x: f[0][0], m_start_y: f[0][1], m_end_x: f[1][0], m_end_y: f[1][1], m_DPoint2_x: f[2][0], m_DPoint2_y: f[2][1], m_DPoint3_x: f[3][0], m_DPoint3_y: f[3][1], m_Color: it.rgb });
    }
    doc.entities.push(e);
  }
}

function drawFrame(spec) {             // group 0, paper mm: neutral A3 frame + title strip (no client data)
  const F = new Sheet(), [x1, y1, x2, y2] = PAPER.frame, ty = y1 + PAPER.title;
  F.rect('0:0', PEN.frame, x1, y1, x2, y2);
  F.line('0:0', PEN.frame, [x1, ty], [x2, ty]);
  const cells = [[x1, -40, '工事名', spec.title.project, 4], [-40, 60, '図面名', spec.title.drawing, 4], [60, 105, '縮尺', `${spec.title.scale} (A3)`, 3], [105, 155, '日付', spec.title.date || '-', 3], [155, x2, '図番', spec.title.sheet, 4]];
  for (const [a, b, cap, val, st] of cells) {
    if (a > x1) F.line('0:0', PEN.frameThin, [a, y1], [a, ty]);
    F.items.push({ k: 'text', layer: '0:D', at: [a + 1.5, ty - 3.2], text: cap, style: 1, angle: 0, color: 2 });
    const l = textLen(val, st);
    F.items.push({ k: 'text', layer: '0:D', at: [(a + b) / 2 - l / 2, y1 + 4.5], text: val, style: st, angle: 0, color: 2 });
  }
  return F;
}

/**
 * Draw a plan. Returns { bytes, doc, model, layout, labels, tags, dims, warnings }.
 * Throws E_SPEC (error.details = messages) for invalid specs.
 */
export function drawPlan(input) {
  const norm = normalizeSpec(input);
  if (norm.errors.length) throw Object.assign(new Error(`E_SPEC: ${norm.errors.join('; ')}`), { code: 'E_SPEC', details: norm.errors });
  const built = buildModel(norm.spec);
  if (built.errors.length) throw Object.assign(new Error(`E_SPEC: ${built.errors.join('; ')}`), { code: 'E_SPEC', details: built.errors });
  const m = built.model, opt = m.spec.options, S = new Sheet();
  if (opt.auxGrid) drawAuxGrid(S, m);
  drawWalls(S, m);
  if (opt.hatch) drawAddedInsulation(S, m);
  if (opt.insulation) drawInsulation(S, m);
  drawColumns(S, m);
  drawOpenings(S, m);
  drawItems(S, m);
  drawDoma(S, m);
  const tags = opt.tags ? drawTags(S, m) : [];
  const labels = drawRoomLabels(S, m);
  const dims = drawDimensions(S, m, tags);
  drawGridBubbles(S, m, dims.base);
  // Layout: centre the group-1 drawing in the sheet area above the title strip, snapped to 10 mm.
  let bb = S.bbox();
  const [ax1, ay1, ax2, ay2] = PAPER.area, cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
  const shift = [Math.round((cx - (ax1 + ax2) / 2 * SCALE) / 10) * 10, Math.round((cy - (ay1 + ay2) / 2 * SCALE) / 10) * 10];
  const fits = (bb[2] - bb[0]) / SCALE <= ax2 - ax1 && (bb[3] - bb[1]) / SCALE <= ay2 - ay1, lateWarnings = [];
  if (opt.northArrow) {
    // first sheet corner (paper mm, inside the frame) whose 30 mm square misses the drawing
    const cands = [[ax1 + 14, ay2 - 20], [ax2 - 14, ay2 - 20], [ax1 + 14, ay1 + 14], [ax2 - 14, ay1 + 14]].map(([x, y]) => [x * SCALE + shift[0], y * SCALE + shift[1]]);
    const ptsOf = it => it.k === 'line' ? [it.a, it.b, [(it.a[0] + it.b[0]) / 2, (it.a[1] + it.b[1]) / 2]] : it.k === 'arc' ? [it.c] : it.k === 'solid' ? it.pts : [it.at];
    const used = S.items.flatMap(ptsOf), longLines = S.items.filter(it => it.k === 'line');
    const free = cands.find(([x, y]) => { const r = { x1: x - 800, y1: y - 800, x2: x + 800, y2: y + 1000 };
      return !used.some(p => inRect(r, p)) && !longLines.some(l => lineRectInterval(l.a, unit(sub(l.b, l.a)), r)?.some?.(() => true) && segHits(l, r)); });
    if (free) drawNorthArrow(S, free); else lateWarnings.push('north arrow omitted: no free sheet corner');
    bb = S.bbox();
  }
  const doc = newDocument();
  doc.header.m_strMemo = `fresco plan-generator origin=${shift[0]},${shift[1]} scale=${SCALE}`;
  toEntities(doc, S.items, 1, shift);
  toEntities(doc, drawFrame(m.spec).items, 0, [0, 0]);
  const bytes = encodeJww(doc);
  const warnings = [...norm.warnings, ...built.warnings, ...lateWarnings];
  if (!fits) warnings.push(`drawing ${round((bb[2] - bb[0]) / SCALE, 1)}x${round((bb[3] - bb[1]) / SCALE, 1)} mm exceeds the A3 drawing area at 1/${SCALE}`);
  return { bytes, doc, model: m, layout: { shift, scale: SCALE, bboxModel: bb, fits }, labels, tags, dims, warnings, primitives: S.items };
}
export { pointInPolygon };
