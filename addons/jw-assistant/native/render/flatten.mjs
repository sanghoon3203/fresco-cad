// Flatten a decoded JWW (native/codec) into paper-mm drawing primitives with block instances expanded.
// Used for our own raster preview (tools/render-png.ps1) so self-evaluation does not depend on Jw_cad redraw timing.
const fail = code => { throw Object.assign(new Error(code), { code }); };
const compose = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const apply = (m, [x, y]) => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
const blockMatrix = g => { const c = Math.cos(g.rotationRadians), s = Math.sin(g.rotationRadians);
  return [c*g.scaleX, s*g.scaleX, -s*g.scaleY, c*g.scaleY, g.at[0], g.at[1]]; };
const ARC_STEPS = 48;

function arcPoints(g) {
  const sweep = g.full ? Math.PI * 2 : g.sweepRadians, n = Math.max(4, Math.ceil(ARC_STEPS * Math.abs(sweep) / (Math.PI * 2)));
  const ct = Math.cos(g.tiltRadians), st = Math.sin(g.tiltRadians), ry = g.radius * (g.flatness || 1), pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (g.full ? 0 : g.startRadians) + sweep * i / n, x = g.radius * Math.cos(a), y = ry * Math.sin(a);
    pts.push([g.center[0] + x*ct - y*st, g.center[1] + x*st + y*ct]);
  }
  return pts;
}

/** @returns {{primitives: object[], bbox: number[]|null, counts: object}} */
export function flattenDrawing(view, { layers = null, groups = null, maxPrimitives = 400000 } = {}) {
  if (!view || !Array.isArray(view.entities)) fail('E_RENDER_INPUT');
  const blocks = new Map((view.blocks ?? []).map(b => [b.number, b])), out = [], counts = {};
  const wanted = e => (!layers || layers.includes(e.layer)) && (!groups || groups.includes(e.layer.split(':')[0]));
  let bbox = null;
  const grow = p => { if (!p.every(Number.isFinite)) return; bbox = bbox ? [Math.min(bbox[0], p[0]), Math.min(bbox[1], p[1]), Math.max(bbox[2], p[0]), Math.max(bbox[3], p[1])] : [p[0], p[1], p[0], p[1]]; };
  const push = (prim, pts) => { if (out.length >= maxPrimitives) fail('E_RENDER_LIMIT'); pts.forEach(grow); out.push(prim); counts[prim.t] = (counts[prim.t] ?? 0) + 1; };
  function visit(e, m, layer, depth) {
    const pen = { color: e.pen?.color ?? 2, style: e.pen?.style ?? 1, width: e.pen?.width ?? 0 }, g = e.geometry;
    if (!g) return;
    switch (e.kind) {
      case 'line': { const a = apply(m, g.start), b = apply(m, g.end); push({ t: 'line', layer, ...pen, pts: [a, b] }, [a, b]); break; }
      case 'arc': { const pts = arcPoints(g).map(p => apply(m, p)); push({ t: 'poly', layer, ...pen, pts }, pts); break; }
      case 'point': { const p = apply(m, g.at); if (!g.temporary) push({ t: 'point', layer, ...pen, pts: [p] }, [p]); break; }
      case 'solid': { const pts = g.points.map(p => apply(m, p)); push({ t: 'solid', layer, color: pen.color, rgb: g.rgb ?? null, pts }, pts); break; }
      case 'text': {
        const p = apply(m, g.at), scale = Math.hypot(m[0], m[1]), rot = Math.atan2(m[1], m[0]) * 180 / Math.PI;
        push({ t: 'text', layer, color: pen.color, text: g.text, height: g.height * scale, width: g.width * scale, angle: (g.angleDegrees ?? 0) + rot, pts: [p] }, [p]);
        break;
      }
      case 'dimension': { visit({ kind: 'line', pen: e.pen, geometry: g.line }, m, layer, depth); visit({ kind: 'text', pen: e.pen, geometry: g.text }, m, layer, depth); break; }
      case 'block': {
        const def = blocks.get(g.number);
        if (!def || depth > 16) return;
        const next = compose(m, blockMatrix(g));
        for (const child of def.children ?? []) visit(child, next, layer, depth + 1);
        break;
      }
    }
  }
  for (const e of view.entities) if (wanted(e)) visit(e, [1, 0, 0, 1, 0, 0], e.layer, 0);
  return { primitives: out, bbox, counts };
}
