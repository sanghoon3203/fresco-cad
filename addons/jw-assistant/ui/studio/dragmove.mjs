// Direct manipulation of the selection on the canvas: pure snapping math (tested) shared by the canvas.
// Paper mm in, paper mm out; the grid is the Japanese module in *model* mm (455 = half-ken, 910 = 1 ken) applied to the
// translation, so a moved element keeps its alignment with the module. Endpoints of other visible entities snap in 2-D
// and win over the grid. Both use the same soft detent as motion.detent(): sticky core, continuous edge, 1:1 outside.
import { detent, magneticSnap } from '../motion.mjs';

export const MODULE_MM = 455;
export const SNAP_PX = 10;

/**
 * moveSnap({ raw:[dx,dy] paper mm, ref:[x,y] paper mm (grabbed vertex, or null), endpoints:[[x,y]...] paper mm,
 *            scale (model mm per paper mm), zoom (screen px per paper mm), free (Alt: no snapping), radiusPx })
 * → { d:[dx,dy] presented paper mm, snap: null | { kind:'endpoint', point } | { kind:'grid', axes:{x,y}, major:{x,y} },
 *     engaged, model:[dx,dy] model mm (rounded to 0.1) }
 */
export function moveSnap({ raw, ref = null, endpoints = [], scale = 1, zoom = 1, free = false, radiusPx = SNAP_PX }) {
  const R = radiusPx / Math.max(zoom, 1e-9); // paper mm
  const out = (d, snap, engaged) => ({ d, snap, engaged, model: d.map(v => Math.round(v * scale * 10) / 10) });
  if (free) return out([raw[0], raw[1]], null, false);
  if (ref) {
    const px = ref[0] + raw[0], py = ref[1] + raw[1];
    let best = null, bestD = R;
    for (const p of endpoints) { const dd = Math.hypot(p[0] - px, p[1] - py); if (dd < bestD) { bestD = dd; best = p; } }
    if (best) {
      const ex = px - best[0], ey = py - best[1], m = Math.hypot(ex, ey), k = m > 0 ? detent(m, 0, R) / m : 0;
      const d = [best[0] + ex * k - ref[0], best[1] + ey * k - ref[1]];
      return out(d, { kind: 'endpoint', point: best, target: [best[0] - ref[0], best[1] - ref[1]] }, m * k <= R * 0.12);
    }
  }
  const step = MODULE_MM, sx = magneticSnap(raw[0] * scale, { step, radius: R * scale }), sy = magneticSnap(raw[1] * scale, { step, radius: R * scale });
  const axes = { x: sx.target !== null, y: sy.target !== null };
  if (!axes.x && !axes.y) return out([raw[0], raw[1]], null, false);
  const d = [sx.value / scale, sy.value / scale];
  const target = [axes.x ? sx.target / scale : d[0], axes.y ? sy.target / scale : d[1]];
  const major = { x: axes.x && Math.round(sx.target / step) % 2 === 0, y: axes.y && Math.round(sy.target / step) % 2 === 0 };
  return out(d, { kind: 'grid', axes, major, target }, (axes.x ? sx.engaged : true) && (axes.y ? sy.engaged : true));
}

/** Rest position for a release: the engaged snap target, else the presented offset rounded to 1 model mm. */
export function releaseTarget(result, scale = 1) {
  if (result.snap && result.engaged) return result.snap.target.slice();
  return result.d.map(v => Math.round(v * scale) / scale);
}
