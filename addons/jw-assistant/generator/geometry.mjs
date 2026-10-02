// Planar helpers for the plan generator. Model millimetres, x right, y up. Walls are axis-aligned.
export const EPS = 1e-6;
export const round = (v, k = 1000) => Math.round(v * k) / k;
export const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
export const samePoint = (p, q, tol = 0.5) => near(p[0], q[0], tol) && near(p[1], q[1], tol);
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const mul = (a, k) => [a[0] * k, a[1] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const len = a => Math.hypot(a[0], a[1]);
export const unit = a => { const l = len(a); return l < EPS ? [0, 0] : [a[0] / l, a[1] / l]; };
export const leftNormal = d => [-d[1], d[0]];

export function signedArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}
/** Drop repeated and collinear vertices; return counter-clockwise order. */
export function normalizePolygon(input) {
  let pts = input.map(p => [Number(p[0]), Number(p[1])]);
  pts = pts.filter((p, i) => !samePoint(p, pts[(i + 1) % pts.length], 1e-3));
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) < 1e-6) { pts.splice(i, 1); changed = true; break; }
    }
  }
  if (signedArea(pts) < 0) pts.reverse();
  return pts;
}
export const isRectilinear = pts => pts.every((p, i) => { const q = pts[(i + 1) % pts.length]; return near(p[0], q[0], 1e-6) || near(p[1], q[1], 1e-6); });
export const polygonEdges = pts => pts.map((p, i) => [p, pts[(i + 1) % pts.length]]);

/** Offset a CCW polygon by d along the inward normal (d < 0 grows it). Mitred joins (exact for rectilinear). */
export function offsetPolygon(pts, d) {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[(i + n - 1) % n], c = pts[(i + 1) % n];
    const n1 = leftNormal(unit(sub(p, a))), n2 = leftNormal(unit(sub(c, p)));
    const k = 1 + dot(n1, n2);
    return add(p, mul(add(n1, n2), d / k));
  });
}
export function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function pointOnSegment(p, a, b, tol = 0.5) {
  const ab = sub(b, a), l = len(ab);
  if (l < EPS) return samePoint(p, a, tol);
  const t = dot(sub(p, a), ab) / (l * l);
  if (t < -tol / l || t > 1 + tol / l) return false;
  return len(sub(p, add(a, mul(ab, t)))) <= tol;
}

// ---------- intervals ----------
/** Subtract intervals `cuts` from [a,b]; returns kept sub-intervals longer than minLen. */
export function subtractIntervals(a, b, cuts, minLen = 0.5) {
  let parts = [[Math.min(a, b), Math.max(a, b)]];
  for (const [c0, c1] of cuts) {
    const lo = Math.min(c0, c1), hi = Math.max(c0, c1), next = [];
    for (const [p0, p1] of parts) {
      if (hi <= p0 || lo >= p1) { next.push([p0, p1]); continue; }
      if (lo > p0) next.push([p0, lo]);
      if (hi < p1) next.push([hi, p1]);
    }
    parts = next;
  }
  return parts.filter(([p0, p1]) => p1 - p0 > minLen);
}

// ---------- cell grid (union of rectilinear regions) ----------
const uniq = vals => { const s = [...new Set(vals.map(v => round(v, 100)))].sort((x, y) => x - y); return s; };
/**
 * Build a cell grid over coordinates xs/ys; occupied(cx, cy) decides each cell by its centre.
 * Returns {xs, ys, nx, ny, occ, at(i,j), cellOf(p)}.
 */
export function cellGrid(xsIn, ysIn, occupied) {
  const xs = uniq(xsIn), ys = uniq(ysIn), nx = xs.length - 1, ny = ys.length - 1;
  const occ = new Uint8Array(Math.max(0, nx * ny));
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) occ[j * nx + i] = occupied((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2) ? 1 : 0;
  const find = (arr, v) => { let lo = 0, hi = arr.length - 2; if (v < arr[0] || v > arr.at(-1)) return -1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (arr[m] <= v) lo = m; else hi = m - 1; } return lo; };
  return { xs, ys, nx, ny, occ, at: (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny) ? 0 : occ[j * nx + i], cellOf: p => [find(xs, p[0]), find(ys, p[1])] };
}
/**
 * Boundary of the occupied cells as merged axis-aligned segments.
 * keep(seg) filters unit segments before merging (used to drop opening jamb edges).
 */
export function gridBoundary(grid, keep = () => true) {
  const { xs, ys, nx, ny, at } = grid, out = [];
  for (let i = 0; i <= nx; i++) {
    let run = null;
    for (let j = 0; j <= ny; j++) {
      const edge = j < ny && at(i - 1, j) !== at(i, j) ? [[xs[i], ys[j]], [xs[i], ys[j + 1]]] : null;
      const ok = edge && keep(edge);
      if (ok && run) run[1] = edge[1];
      else if (ok) run = [edge[0], edge[1]];
      else if (run) { out.push(run); run = null; }
    }
  }
  for (let j = 0; j <= ny; j++) {
    let run = null;
    for (let i = 0; i <= nx; i++) {
      const edge = i < nx && at(i, j - 1) !== at(i, j) ? [[xs[i], ys[j]], [xs[i + 1], ys[j]]] : null;
      const ok = edge && keep(edge);
      if (ok && run) run[1] = edge[1];
      else if (ok) run = [edge[0], edge[1]];
      else if (run) { out.push(run); run = null; }
    }
  }
  return out;
}

// ---------- rectangles in a wall frame ----------
/** Axis-aligned world rectangle from a wall frame (origin, unit dir t, normal n) and local u/v ranges. */
export function frameRect(frame, u0, u1, v0, v1) {
  const pts = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => frameToWorld(frame, u, v));
  return { x1: Math.min(...pts.map(p => p[0])), y1: Math.min(...pts.map(p => p[1])), x2: Math.max(...pts.map(p => p[0])), y2: Math.max(...pts.map(p => p[1])) };
}
export const frameToWorld = (f, u, v) => [f.o[0] + f.t[0] * u + f.n[0] * v, f.o[1] + f.t[1] * u + f.n[1] * v];
export const worldToFrame = (f, p) => { const d = sub(p, f.o); return [dot(d, f.t), dot(d, f.n)]; };
export const inRect = (r, p, tol = 0) => p[0] >= r.x1 - tol && p[0] <= r.x2 + tol && p[1] >= r.y1 - tol && p[1] <= r.y2 + tol;
export const rectsOverlap = (a, b, tol = 0) => a.x1 < b.x2 - tol && b.x1 < a.x2 - tol && a.y1 < b.y2 - tol && b.y1 < a.y2 - tol;

// ---------- line clipping ----------
/** Clip the infinite line p + t*d against polygon rings (even-odd); returns [[t0,t1],...]. */
export function clipLineToRings(p, d, rings) {
  const ts = [];
  for (const ring of rings) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], e = sub(b, a);
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-12) continue;
    const w = sub(a, p), t = (w[0] * e[1] - w[1] * e[0]) / den, s = (w[0] * d[1] - w[1] * d[0]) / den;
    if (s >= 0 && s < 1) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i + 1 < ts.length; i += 2) if (ts[i + 1] - ts[i] > 1e-6) out.push([ts[i], ts[i + 1]]);
  return out;
}
/** Parameter interval of line p + t*d inside an axis-aligned rect (or null). */
export function lineRectInterval(p, d, r) {
  let t0 = -Infinity, t1 = Infinity;
  for (const [pi, di, lo, hi] of [[p[0], d[0], r.x1, r.x2], [p[1], d[1], r.y1, r.y2]]) {
    if (Math.abs(di) < 1e-12) { if (pi < lo || pi > hi) return null; continue; }
    let a = (lo - pi) / di, b = (hi - pi) / di;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
  }
  return t1 > t0 ? [t0, t1] : null;
}

export const fmtThousands = n => Math.round(n).toLocaleString('en-US');
