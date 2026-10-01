// Machine checks for eval tasks. Selectors resolve by geometry / text / layer against the BEFORE drawing
// (entity ids are file-local and may change after a rewrite, so checks never rely on raw ids).
import { normalizeText, sameGeometry, shiftEntity } from '../ai/context.mjs';

const CHECK_TYPES = new Set(['entityMoved', 'entityCountDelta', 'textExists', 'textAbsent', 'lineExists', 'entityDeleted', 'layerOf', 'noChangeOutside', 'clarificationExpected', 'status']);
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
function pointSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function distanceToPoint(e, p) {
  const g = e.geom;
  if (g.kind === 'line') return pointSegment(p, g.start, g.end);
  if (g.at) return dist(g.at, p);
  if (g.center) return dist(g.center, p);
  if (!e.bbox) return Infinity;
  return Math.hypot(Math.max(0, e.bbox[0] - p[0], p[0] - e.bbox[2]), Math.max(0, e.bbox[1] - p[1], p[1] - e.bbox[3]));
}
const near2 = (a, b, tol) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;

/** Resolve a selector to entities of an index. Fields: kind, layer, text, textContains, near+radius, start+end(+tol), bbox. */
export function resolveSelector(index, sel = {}) {
  const tol = sel.tol ?? 2;
  return index.entities.filter(e => {
    if (sel.kind && e.kind !== sel.kind) return false;
    if (sel.layer && e.layerId !== sel.layer) return false;
    if (sel.text !== undefined && e.norm !== normalizeText(sel.text)) return false;
    if (sel.textContains !== undefined && !(e.norm ?? '').includes(normalizeText(sel.textContains))) return false;
    if (sel.near && !(distanceToPoint(e, sel.near) <= (sel.radius ?? 500))) return false;
    if (sel.start && sel.end) {
      const g = e.geom;
      if (g.kind !== 'line' || !((near2(g.start, sel.start, tol) && near2(g.end, sel.end, tol)) || (near2(g.start, sel.end, tol) && near2(g.end, sel.start, tol)))) return false;
    }
    if (sel.bbox && !(e.bbox && e.bbox[0] >= sel.bbox[0] && e.bbox[1] >= sel.bbox[1] && e.bbox[2] <= sel.bbox[2] && e.bbox[3] <= sel.bbox[3])) return false;
    return true;
  });
}
const countMatching = (index, want, tol, layer = want.layerId) => index.entities.filter(c => c.kind === want.kind && (!layer || c.layerId === layer) && sameGeometry(want, c, tol)).length;
const signature = e => {
  const g = e.geom, R = v => Number.isFinite(v) ? Math.round(v) : 'x';
  const pts = g.kind === 'line' ? [g.start, g.end].map(p => p.map(R).join(',')).sort().join(';') : g.kind === 'text' ? `${g.at?.map(R).join(',')}|${g.text}`
    : g.center ? `${g.center.map(R).join(',')}|${R(g.radius)}` : g.at ? g.at.map(R).join(',') : (e.bbox ?? []).map(R).join(',');
  return `${e.kind}|${e.layerId}|${pts}`;
};
const outside = (e, box) => e.bbox && (e.bbox[2] < box[0] || e.bbox[0] > box[2] || e.bbox[3] < box[1] || e.bbox[1] > box[3]);

export function validateTask(task) {
  const problems = [];
  if (!task || typeof task.id !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/u.test(task.id)) problems.push('id');
  if (typeof task.file !== 'string' || !task.file) problems.push('file');
  if (!task.instruction_ja && !task.instruction_ko) problems.push('instruction');
  if (!Array.isArray(task.expect) || !task.expect.length) problems.push('expect');
  for (const c of task.expect ?? []) if (!CHECK_TYPES.has(c?.type)) problems.push(`check:${c?.type}`);
  if (problems.length) throw Object.assign(new Error(`E_EVAL_TASK: ${task?.id ?? '?'} ${problems.join(',')}`), { code: 'E_EVAL_TASK' });
  return task;
}

/** Evaluate one check. Returns { type, passed, detail }. */
export function evaluateCheck(check, { before, after, result }) {
  const out = (passed, detail) => ({ type: check.type, passed, detail });
  if (check.type === 'clarificationExpected') return out(result?.status === 'clarification', `status=${result?.status}`);
  if (check.type === 'status') return out(result?.status === check.value, `status=${result?.status}`);
  if (!after) return out(false, `no edited drawing (status=${result?.status})`);
  const tol = check.tol ?? 1;
  switch (check.type) {
    case 'entityMoved': {
      const sel = resolveSelector(before, check.selector);
      if (!sel.length) return out(false, 'selector matched nothing in the source drawing');
      const missing = sel.filter(e => countMatching(after, shiftEntity(e, check.dx, check.dy), tol, check.layer ?? e.layerId) < 1);
      const stayed = sel.filter(e => countMatching(after, e, tol) >= countMatching(before, e, tol));
      return out(!missing.length && !stayed.length, `${sel.length} selected, ${missing.length} not at target, ${stayed.length} still at origin`);
    }
    case 'entityCountDelta': {
      const n = idx => idx.entities.filter(e => (!check.kind || e.kind === check.kind) && (!check.layer || e.layerId === check.layer)).length;
      const delta = n(after) - n(before);
      return out(delta === check.delta, `delta=${delta}, expected ${check.delta}`);
    }
    case 'textExists': {
      const hits = resolveSelector(after, { kind: 'text', [check.contains ? 'textContains' : 'text']: check.text, layer: check.layer, near: check.near, radius: check.radius ?? 1500 });
      return out(check.count === undefined ? hits.length >= 1 : hits.length === check.count, `${hits.length} matching text(s)`);
    }
    case 'textAbsent': {
      const hits = resolveSelector(after, { kind: 'text', [check.contains ? 'textContains' : 'text']: check.text, layer: check.layer, near: check.near, radius: check.radius ?? 1500 });
      return out(hits.length === 0, `${hits.length} matching text(s) remain`);
    }
    case 'lineExists': {
      const hits = resolveSelector(after, { kind: 'line', start: check.start, end: check.end, layer: check.layer, tol: check.tol ?? 2 });
      return out(hits.length >= 1, `${hits.length} matching line(s)`);
    }
    case 'entityDeleted': {
      const sel = resolveSelector(before, check.selector);
      if (!sel.length) return out(false, 'selector matched nothing in the source drawing');
      const remaining = sel.filter(e => countMatching(after, e, tol) >= countMatching(before, e, tol));
      return out(!remaining.length, `${sel.length} selected, ${remaining.length} still present`);
    }
    case 'layerOf': {
      const sel = resolveSelector(before, check.selector);
      if (!sel.length) return out(false, 'selector matched nothing in the source drawing');
      const wrong = sel.filter(e => countMatching(after, e, tol, check.layer) < 1);
      return out(!wrong.length, `${sel.length} selected, ${wrong.length} not on ${check.layer}`);
    }
    case 'noChangeOutside': {
      const tally = (idx, sign) => { const m = new Map(); for (const e of idx.entities) if (outside(e, check.bbox)) { const k = signature(e); m.set(k, (m.get(k) ?? 0) + sign); } return m; };
      const diff = tally(before, 1);
      for (const [k, v] of tally(after, -1)) diff.set(k, (diff.get(k) ?? 0) + v);
      const changed = [...diff.values()].filter(v => v !== 0).length;
      return out(changed === 0, `${changed} geometry signature(s) changed outside the box`);
    }
    default: return out(false, 'unknown check');
  }
}

/** Score a task case: every check must pass for `passed`; `score` is the fraction of passing checks. */
export function scoreTask(task, ctx) {
  const checks = task.expect.map(c => evaluateCheck(c, ctx));
  const expectsClarification = task.expect.some(c => c.type === 'clarificationExpected');
  if (!expectsClarification && !task.expect.some(c => c.type === 'status')) checks.unshift(evaluateCheck({ type: 'status', value: 'applied' }, ctx));
  const passedCount = checks.filter(c => c.passed).length;
  return { checks, passed: passedCount === checks.length, score: Math.round(passedCount / checks.length * 1000) / 1000 };
}
