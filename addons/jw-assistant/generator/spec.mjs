// Plan spec: normalisation + validation. See plan-spec.md for the language.
import { SYMBOLS } from './symbols.mjs';
import { normalizePolygon, isRectilinear } from './geometry.mjs';
import { buildModel } from './model.mjs';

export const OPENING_TYPES = ['window-sliding', 'door-swing', 'door-sliding', 'door-sliding-double', 'entrance-door', 'opening'];
export const ROOM_KINDS = ['living', 'bedroom', 'kitchen', 'wet', 'toilet', 'corridor', 'entrance', 'storage', 'other'];
export const COMPASS = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] };
export const SIDES = ['S', 'E', 'N', 'W'];

export const MODULE = 455;
/** v lies on the 455 lattice anchored at origin (0.5 mm tolerance). */
export const onModule = (v, origin = 0) => { const r = (((v - origin) % MODULE) + MODULE) % MODULE; return r < 0.5 || MODULE - r < 0.5; };
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPt = p => Array.isArray(p) && p.length === 2 && p.every(isNum);

function gridAxis(v, name, errors) {
  if (Array.isArray(v)) {
    if (v.length < 2 || !v.every(isNum)) { errors.push(`grid.${name}: need >= 2 numbers`); return []; }
    const s = [...v].sort((a, b) => a - b);
    if (s.some((x, i) => i && x - s[i - 1] < 1)) errors.push(`grid.${name}: duplicate grid lines`);
    return s;
  }
  if (v && isNum(v.pitch) && Number.isInteger(v.count) && v.count >= 2) return Array.from({ length: v.count }, (_, i) => (v.start ?? 0) + i * v.pitch);
  errors.push(`grid.${name}: array of positions or {pitch,count[,start]}`);
  return [];
}

/** Normalise a user/AI spec. Returns {spec, errors[], warnings[]} (structural checks only; geometry in model.mjs). */
export function normalizeSpec(input) {
  const errors = [], warnings = [];
  if (!input || typeof input !== 'object') return { spec: null, errors: ['spec must be an object'], warnings };
  const s = {
    name: String(input.name ?? 'plan').replace(/[^\w.-]+/gu, '-'),
    title: { project: 'サンプルプラン', drawing: '1階平面図', scale: '1/50', date: '', sheet: 'A-01', ...(input.title ?? {}) },
    grid: { x: gridAxis(input.grid?.x, 'x', errors), y: gridAxis(input.grid?.y, 'y', errors), xLabels: input.grid?.xLabels, yLabels: input.grid?.yLabels },
    exterior: [], walls: [], openings: [], rooms: [], items: [],
    dims: { sides: input.dims?.sides ?? SIDES, first: input.dims?.first ?? 1150, pitch: input.dims?.pitch ?? 230 },
    options: { insulation: true, hatch: true, auxGrid: true, tags: true, columns: true, northArrow: true, ...(input.options ?? {}) }
  };
  for (const [k, ax] of [['x', s.grid.x], ['y', s.grid.y]]) ax.forEach((g, i) => { if (i && !onModule(g, ax[0])) errors.push(`grid.${k}[${i}] = ${g}: grid spacing must be a multiple of 455 (尺モジュール)`); });
  s.grid.xLabels = Array.isArray(s.grid.xLabels) && s.grid.xLabels.length === s.grid.x.length ? s.grid.xLabels.map(String) : s.grid.x.map((_, i) => `X${i + 1}`);
  s.grid.yLabels = Array.isArray(s.grid.yLabels) && s.grid.yLabels.length === s.grid.y.length ? s.grid.yLabels.map(String) : s.grid.y.map((_, i) => `Y${i + 1}`);
  if (!s.dims.sides.every(x => SIDES.includes(x))) errors.push('dims.sides: subset of S,E,N,W');

  if (!Array.isArray(input.exterior) || input.exterior.length < 4 || !input.exterior.every(isPt)) errors.push('exterior: polygon of >= 4 [x,y] points');
  else {
    s.exterior = normalizePolygon(input.exterior);
    if (!isRectilinear(s.exterior)) errors.push('exterior: only axis-aligned (rectilinear) polygons are supported');
    for (const p of s.exterior) if (!onModule(p[0], s.grid.x[0]) || !onModule(p[1], s.grid.y[0])) errors.push(`exterior vertex ${p} is off the 455 module (尺モジュール)`);
  }
  (input.walls ?? []).forEach((w, i) => {
    const from = Array.isArray(w) ? [w[0], w[1]] : w?.from, to = Array.isArray(w) ? [w[2], w[3]] : w?.to;
    if (!isPt(from) || !isPt(to)) { errors.push(`walls[${i}]: need from/to points`); return; }
    if (Math.abs(from[0] - to[0]) > 0.01 && Math.abs(from[1] - to[1]) > 0.01) { errors.push(`walls[${i}]: must be horizontal or vertical`); return; }
    if (Math.hypot(from[0] - to[0], from[1] - to[1]) < 200) { errors.push(`walls[${i}]: too short`); return; }
    s.walls.push({ id: w.id ?? `w${i + 1}`, from: [...from], to: [...to] });
  });
  (input.openings ?? []).forEach((o, i) => {
    const where = `openings[${i}]${o?.id ? ` (${o.id})` : ''}`;
    if (!OPENING_TYPES.includes(o?.type)) { errors.push(`${where}: type must be one of ${OPENING_TYPES.join('|')}`); return; }
    if (!isPt(o.at)) { errors.push(`${where}: at [x,y] on a wall centreline`); return; }
    if (!isNum(o.width) || o.width < 600 || o.width > 3640) { errors.push(`${where}: width (column-centre span, 600..3640)`); return; }
    const n = { id: o.id ?? `${o.type.startsWith('window') ? 'W' : 'D'}${i + 1}`, type: o.type, at: [...o.at], width: o.width, height: o.height ?? null,
      hinge: o.hinge ?? 'start', swing: o.swing ?? null, slide: o.slide ?? 'start', tag: o.tag ?? null };
    if (!['start', 'end'].includes(n.hinge)) errors.push(`${where}: hinge start|end`);
    if (!['start', 'end'].includes(n.slide)) errors.push(`${where}: slide start|end`);
    if (n.type === 'door-swing' && !COMPASS[n.swing]) errors.push(`${where}: door-swing needs swing N|S|E|W`);
    if (n.swing !== null && !COMPASS[n.swing]) errors.push(`${where}: swing N|S|E|W`);
    s.openings.push(n);
  });
  const ids = new Set();
  for (const o of s.openings) { if (ids.has(o.id)) errors.push(`opening id ${o.id} duplicated`); ids.add(o.id); }
  (input.rooms ?? []).forEach((r, i) => {
    if (typeof r?.name !== 'string' || !r.name.trim() || !isPt(r.at)) { errors.push(`rooms[${i}]: need name and at [x,y]`); return; }
    const kind = r.kind ?? guessKind(r.name);
    if (!ROOM_KINDS.includes(kind)) errors.push(`rooms[${i}]: kind must be one of ${ROOM_KINDS.join('|')}`);
    const rect = r.rect ?? null, doma = r.doma ?? null;
    for (const [k, v] of [['rect', rect], ['doma', doma]]) if (v !== null && !(Array.isArray(v) && v.length === 4 && v.every(isNum))) errors.push(`rooms[${i}].${k}: [x1,y1,x2,y2]`);
    s.rooms.push({ name: r.name.trim(), at: [...r.at], kind, rect, doma, label: r.label !== false });
  });
  for (const list of [input.items, input.equipment, input.furniture]) (list ?? []).forEach((it, i) => {
    const def = SYMBOLS[it?.type];
    if (!def) { errors.push(`items[${i}]: unknown type ${it?.type} (known: ${Object.keys(SYMBOLS).join(', ')})`); return; }
    if (!isPt(it.at)) { errors.push(`items[${i}] (${it.type}): at [x,y] (centre)`); return; }
    const size = Array.isArray(it.size) && it.size.length === 2 && it.size.every(isNum) ? it.size : def.size;
    s.items.push({ type: it.type, at: [...it.at], rotation: isNum(it.rotation) ? it.rotation : 0, size, label: it.label === undefined ? (def.label ?? null) : it.label, role: def.role });
  });
  return { spec: s, errors, warnings };
}

export function guessKind(name) {
  if (/玄関/u.test(name)) return 'entrance';
  if (/廊下|ホール/u.test(name)) return 'corridor';
  if (/浴室|UB|洗面|脱衣/u.test(name)) return 'wet';
  if (/トイレ|WC|便所/u.test(name)) return 'toilet';
  if (/寝室|洋室|和室|子供/u.test(name)) return 'bedroom';
  if (/LDK|LD|リビング|居間|ダイニング/u.test(name)) return 'living';
  if (/キッチン|台所/u.test(name)) return 'kitchen';
  if (/収納|CL|クローゼット|納戸|物入|SIC|WIC|パントリー/u.test(name)) return 'storage';
  return 'other';
}

/** Full validation: structural normalisation + geometric resolution (walls, openings, rooms). */
export function validateSpec(input) {
  const norm = normalizeSpec(input);
  if (norm.errors.length) return { ok: false, errors: norm.errors, warnings: norm.warnings, spec: norm.spec };
  const built = buildModel(norm.spec);
  return { ok: built.errors.length === 0, errors: built.errors, warnings: [...norm.warnings, ...built.warnings], spec: norm.spec,
    rooms: built.model.rooms.map(r => ({ name: r.name, kind: r.kind, areaM2: r.areaM2, jo: r.jo })) };
}

const pt = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, rect = { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 };
const axis = { oneOf: [{ type: 'array', items: { type: 'number' }, minItems: 2 }, { type: 'object', required: ['pitch', 'count'], properties: { pitch: { type: 'number' }, count: { type: 'integer', minimum: 2 }, start: { type: 'number' } } }] };
/** JSON Schema (draft 2020-12) of the plan spec, for prompting/validating AI-written specs. Units: model mm, X1/Y1 at (0,0), y up (north). */
export const PLAN_SPEC_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'fresco plan spec', type: 'object', required: ['grid', 'exterior'],
  properties: {
    name: { type: 'string' },
    title: { type: 'object', properties: { project: { type: 'string' }, drawing: { type: 'string' }, scale: { type: 'string' }, date: { type: 'string' }, sheet: { type: 'string' } } },
    grid: { type: 'object', required: ['x', 'y'], properties: { x: axis, y: axis, xLabels: { type: 'array', items: { type: 'string' } }, yLabels: { type: 'array', items: { type: 'string' } } } },
    exterior: { description: 'rectilinear outline on wall centrelines', type: 'array', items: pt, minItems: 4 },
    walls: { type: 'array', items: { oneOf: [{ type: 'object', required: ['from', 'to'], properties: { id: { type: 'string' }, from: pt, to: pt } }, rect] } },
    openings: { type: 'array', items: { type: 'object', required: ['type', 'at', 'width'], properties: {
      id: { type: 'string' }, type: { enum: OPENING_TYPES }, at: { description: 'centre on a wall centreline', ...pt },
      width: { description: 'jamb-column centre span (rough opening = width - 130)', type: 'number', minimum: 600, maximum: 3640 },
      height: { type: 'number' }, hinge: { enum: ['start', 'end'] }, swing: { enum: Object.keys(COMPASS) }, slide: { enum: ['start', 'end'] }, tag: { type: 'string' } } } },
    rooms: { type: 'array', items: { type: 'object', required: ['name', 'at'], properties: { name: { type: 'string' }, at: pt, kind: { enum: ROOM_KINDS }, rect, doma: rect, label: { type: 'boolean' } } } },
    items: { type: 'array', items: { type: 'object', required: ['type', 'at'], properties: { type: { enum: Object.keys(SYMBOLS) }, at: pt, rotation: { type: 'number' }, size: pt, label: { type: ['string', 'boolean', 'null'] } } } },
    dims: { type: 'object', properties: { sides: { type: 'array', items: { enum: SIDES } }, first: { type: 'number' }, pitch: { type: 'number' } } },
    options: { type: 'object', properties: Object.fromEntries(['insulation', 'hatch', 'auxGrid', 'tags', 'columns', 'northArrow'].map(k => [k, { type: 'boolean' }])) }
  }
};
