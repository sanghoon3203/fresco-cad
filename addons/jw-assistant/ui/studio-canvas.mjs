// Model-space rendering for IR v2. Each displayed primitive retains its top-level selection ID.
const point = (m, x, y) => [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];
export function displayPrimitives(ir) {
  return (ir?.expandedEntities ?? []).flatMap(e => {
    const g = e.geometry, m = e.transformToModel;
    if (!g || !m?.every(Number.isFinite)) return [];
    let vertices = [];
    if (g.kind === 'line' && e.modelPoints?.every(Number.isFinite)) vertices = [e.modelPoints.slice(0, 2), e.modelPoints.slice(2)];
    if (g.kind === 'text' && e.modelAnchor?.every(Number.isFinite)) vertices = [e.modelAnchor];
    if (g.kind === 'point' && e.modelPoint?.every(Number.isFinite)) vertices = [e.modelPoint];
    if (g.kind === 'ellipse-arc' && [...g.center, g.radius, g.ratio, g.tiltRadians, g.startRadians, g.sweepRadians].every(Number.isFinite) && g.radius > 0 && g.ratio > 0) {
      const start = g.full ? 0 : g.startRadians, sweep = g.full ? Math.PI * 2 : g.sweepRadians;
      for (let i = 0; i <= 64; i++) {
        const angle = start + sweep*i/64, x = g.radius*Math.cos(angle), y = g.radius*g.ratio*Math.sin(angle), c = Math.cos(g.tiltRadians), s = Math.sin(g.tiltRadians);
        vertices.push(point(m, g.center[0] + c*x - s*y, g.center[1] + s*x + c*y));
      }
    }
    if (!vertices.length || !vertices.flat().every(Number.isFinite)) return [];
    const xs = vertices.map(p => p[0]), ys = vertices.map(p => p[1]);
    return [{ ...e, rootId: e.path.split('/')[0], vertices, bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }];
  });
}
export function nearestPrimitive(items, x, y, tolerance) {
  let id = null, best = tolerance;
  for (const item of items) {
    for (let i = 0; i < Math.max(1, item.vertices.length - 1); i++) {
      const [ax, ay] = item.vertices[i], [bx, by] = item.vertices[i+1] ?? item.vertices[i];
      const dx = bx-ax, dy = by-ay, t = Math.max(0, Math.min(1, ((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy || 1)));
      const distance = Math.hypot(x-ax-t*dx, y-ay-t*dy);
      if (distance < best) { best = distance; id = item.rootId; }
    }
  }
  return id;
}

export class StudioCanvas {
  constructor(canvas, onSelect, isBusy) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.onSelect = onSelect; this.isBusy = isBusy;
    this.items = []; this.selected = new Set(); this.preview = null; this.layer = ''; this.view = { x: 0, y: 0, zoom: 1 };
    canvas.onwheel = event => {
      event.preventDefault(); const [x,y] = this.screen(event), v = this.view, factor = event.deltaY < 0 ? 1.15 : 1/1.15;
      if (v.zoom*factor < 1e-8 || v.zoom*factor > 1e6) return;
      v.x = x+(v.x-x)*factor; v.y = y+(v.y-y)*factor; v.zoom *= factor; this.draw();
    };
    canvas.onpointerdown = event => {
      if (this.isBusy()) return; const [x,y] = this.screen(event);
      this.drag = { x, y, endX: x, endY: y, viewX: this.view.x, viewY: this.view.y, box: event.shiftKey, moved: false };
      canvas.setPointerCapture(event.pointerId);
    };
    canvas.onpointermove = event => {
      const d = this.drag; if (!d) return;
      [d.endX, d.endY] = this.screen(event); const dx = d.endX-d.x, dy = d.endY-d.y;
      if (Math.abs(dx)+Math.abs(dy) > 4) d.moved = true;
      if (d.moved && !d.box) { this.view.x = d.viewX+dx; this.view.y = d.viewY+dy; }
      this.draw();
    };
    canvas.onpointerup = event => {
      const d = this.drag; this.drag = null; this.draw(); if (!d || this.isBusy()) return;
      if (d.moved && !d.box) return;
      if (d.moved) {
        const a = this.model(d.x,d.y), b = this.model(d.endX,d.endY), left = Math.min(a[0],b[0]), right = Math.max(a[0],b[0]), bottom = Math.min(a[1],b[1]), top = Math.max(a[1],b[1]);
        const ids = new Set(this.visible().filter(e => e.bounds[0]>=left && e.bounds[2]<=right && e.bounds[1]>=bottom && e.bounds[3]<=top).map(e => e.rootId));
        this.onSelect([...ids], false);
      } else { const [x,y] = this.model(...this.screen(event)), id = nearestPrimitive(this.visible(), x,y, 8/this.view.zoom); this.onSelect(id ? [id] : [], event.shiftKey); }
    };
    canvas.onpointercancel = () => { this.drag = null; this.draw(); };
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  screen(event) { const r = this.canvas.getBoundingClientRect(); return [event.clientX-r.left,event.clientY-r.top]; }
  model(x,y) { return [(x-this.view.x)/this.view.zoom, -(y-this.view.y)/this.view.zoom]; }
  visible() { return this.items.filter(e => !this.layer || e.effectiveLayerId === this.layer); }
  setDrawing(ir) { this.items = displayPrimitives(ir); this.preview = null; this.selected.clear(); }
  fit(selectionOnly = false) {
    const items = this.visible().filter(e => !selectionOnly || this.selected.has(e.rootId));
    const bounds = items.map(e => e.bounds);
    for (const change of this.preview?.changes ?? []) bounds.push([Math.min(change.after[0],change.after[2]), Math.min(change.after[1],change.after[3]), Math.max(change.after[0],change.after[2]), Math.max(change.after[1],change.after[3])]);
    if (!bounds.length) return;
    let x1 = Infinity,y1 = Infinity,x2 = -Infinity,y2 = -Infinity;
    for (const b of bounds) { x1=Math.min(x1,b[0]); y1=Math.min(y1,b[1]); x2=Math.max(x2,b[2]); y2=Math.max(y2,b[3]); }
    const w=this.canvas.clientWidth,h=this.canvas.clientHeight;
    this.view.zoom = Math.min((w-60)/Math.max(100,x2-x1), (h-60)/Math.max(100,y2-y1));
    this.view.x = w/2-(x1+x2)/2*this.view.zoom; this.view.y = h/2+(y1+y2)/2*this.view.zoom; this.draw();
  }
  draw() {
    const { canvas, ctx, view: v } = this, dpr = globalThis.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth*dpr); canvas.height = Math.round(canvas.clientHeight*dpr);
    ctx.setTransform(dpr*v.zoom,0,0,-dpr*v.zoom,dpr*v.x,dpr*v.y);
    const changes = new Map((this.preview?.changes ?? []).map(e => [e.id,e]));
    const stroke = (vertices, color, width, dashed = false) => {
      ctx.strokeStyle=color; ctx.lineWidth=width/v.zoom; ctx.setLineDash(dashed ? [6/v.zoom,4/v.zoom] : []);
      ctx.beginPath(); ctx.moveTo(...vertices[0]); for (const p of vertices.slice(1)) ctx.lineTo(...p); ctx.stroke();
    };
    for (const e of this.visible()) {
      const selected = this.selected.has(e.rootId), changed = changes.has(e.rootId), color = changed ? '#c05b26' : selected ? '#df7d16' : '#566b7f';
      if (e.geometry.kind === 'text') {
        const g = e.geometry, m = e.transformToModel, height = g.height;
        if (!(height>0) || height*Math.hypot(m[2],m[3])*v.zoom < 2) continue;
        ctx.save(); ctx.transform(...m); ctx.translate(...g.anchor); ctx.rotate((g.rotationDegrees||0)*Math.PI/180); ctx.scale(1,-1);
        ctx.fillStyle=color; ctx.font=`${height}px "Yu Gothic",sans-serif`; ctx.textBaseline='bottom'; ctx.fillText(g.text ?? '',0,0); ctx.restore();
      } else if (e.vertices.length === 1) { ctx.fillStyle=color; ctx.beginPath(); ctx.arc(...e.vertices[0],2/v.zoom,0,Math.PI*2); ctx.fill(); }
      else stroke(e.vertices,color,selected ? 2 : 0.8,changed);
    }
    for (const change of changes.values()) stroke([change.after.slice(0,2),change.after.slice(2)],'#087d70',3);
    if (this.drag?.box && this.drag.moved) {
      const d=this.drag; ctx.setTransform(dpr,0,0,dpr,0,0); ctx.setLineDash([4,3]); ctx.lineWidth=1; ctx.strokeStyle='#146d70'; ctx.strokeRect(d.x,d.y,d.endX-d.x,d.endY-d.y);
    }
    ctx.setLineDash([]);
  }
}
