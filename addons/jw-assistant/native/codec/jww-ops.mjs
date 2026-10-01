// Mutations on decoded JWW documents. Patch v2 units: model mm = file coordinate x group scale,
// text sizes paper mm (= file units), angles degrees CCW. Untouched records re-encode byte-identically;
// only MFC class-tag PIDs after the first structural change are renumbered, as CArchive requires.
import { RAW, JwwEntity, hex } from './jww-codec.mjs';
import { encodeCp932, fail } from './archive.mjs';

const DEG = Math.PI / 180, TAU = 2 * Math.PI;
const POINTS = {
  CDataSen: [['m_start_x', 'm_start_y'], ['m_end_x', 'm_end_y']],
  CDataEnko: [['m_start_x', 'm_start_y']],
  CDataTen: [['m_start_x', 'm_start_y']],
  CDataMoji: [['m_start_x', 'm_start_y'], ['m_end_x', 'm_end_y']],
  CDataSolid: [['m_start_x', 'm_start_y'], ['m_end_x', 'm_end_y'], ['m_DPoint2_x', 'm_DPoint2_y'], ['m_DPoint3_x', 'm_DPoint3_y']],
  CDataBlock: [['m_DPKijunTen_x', 'm_DPKijunTen_y']]
};
const SUNPOU_PARTS = { m_Sen: 'CDataSen', m_Moji: 'CDataMoji', m_SenHo1: 'CDataSen', m_SenHo2: 'CDataSen', m_Ten1: 'CDataTen', m_Ten2: 'CDataTen', m_TenHo1: 'CDataTen', m_TenHo2: 'CDataTen' };

function cloneRec(value) {
  if (Array.isArray(value)) return value.map(cloneRec);
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = cloneRec(v);
  if (value[RAW]) out[RAW] = new Map(value[RAW]);
  return out;
}
const cloneEntity = e => new JwwEntity(e.id, e.cls, cloneRec(e.props), e.children?.map(cloneEntity));
/** Deep copy that keeps original string/NaN bytes, so untouched fields still re-encode exactly. */
export function cloneDoc(doc) {
  return { ...doc, header: cloneRec(doc.header), entities: doc.entities.map(cloneEntity), blocks: doc.blocks.map(cloneEntity),
    images: doc.images?.map(cloneRec) ?? null, schemas: { ...doc.schemas }, diagnostics: [...doc.diagnostics], spans: { ...doc.spans } };
}

export const findEntity = (doc, id) => doc.entities.find(e => e.id === id) ?? fail('E_CODEC_ENTITY', id);
const scaleOf = (doc, g) => { const s = doc.header.m_adScale[g]; return Number.isFinite(s) && s > 0 ? s : fail('E_CODEC_SCALE', `group ${hex(g)}`); };
const parseLayer = layer => {
  const m = /^([0-9A-F]):([0-9A-F])$/u.exec(layer ?? '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16)] : fail('E_CODEC_LAYER', layer);
};
function eachPoint(cls, props, fn) {
  if (cls === 'CDataSunpou') { for (const [part, sub] of Object.entries(SUNPOU_PARTS)) if (props[part]) eachPoint(sub, props[part], fn); return; }
  for (const [x, y] of POINTS[cls] ?? fail('E_CODEC_KIND', cls)) [props[x], props[y]] = fn(props[x], props[y]);
}
// NaN fields decoded from the file keep their raw bytes; any other non-finite value is a mutation bug.
const checkFinite = (props, where) => { for (const [k, v] of Object.entries(props)) if (typeof v === 'number' && !Number.isFinite(v) && !(Number.isNaN(v) && props[RAW]?.get(k)?.nan)) fail('E_CODEC_VALUE', `${where}.${k}`); };

/** Jw_cad text run length in paper mm: full-width = width, CP932 single-byte = width/2, plus spacing between characters. */
export function textLength(text, width, spacing) {
  let length = 0, n = 0;
  for (const ch of text) { const b = encodeCp932(ch); length += b?.length === 1 ? width / 2 : width; n++; }
  return length + spacing * Math.max(0, n - 1);
}
function updateTextEnd(p) {
  const length = textLength(p.m_string, p.m_dSizeX, p.m_dKankaku), a = p.m_degKakudo * DEG;
  p.m_end_x = p.m_start_x + length * Math.cos(a); p.m_end_y = p.m_start_y + length * Math.sin(a);
}
function arcAngles(p, startDeg, sweepDeg) {
  if (Math.abs(sweepDeg) >= 360) { p.m_radKaishiKaku = startDeg * DEG; p.m_radEnkoKaku = TAU; p.m_bZenEnFlg = 1; return; }
  if (sweepDeg < 0) { startDeg += sweepDeg; sweepDeg = -sweepDeg; }
  p.m_radKaishiKaku = (((startDeg % 360) + 360) % 360) * DEG; p.m_radEnkoKaku = sweepDeg * DEG; p.m_bZenEnFlg = 0;
}
const markDirty = doc => { if (doc.partial) fail('E_JWW_CODEC_PARTIAL'); doc.dirty = true; };

export function translateEntity(doc, id, dx, dy) {
  markDirty(doc);
  const e = findEntity(doc, id), s = scaleOf(doc, e.props.m_nGLayer);
  eachPoint(e.cls, e.props, (x, y) => [x + dx / s, y + dy / s]);
  return e;
}
export function deleteEntities(doc, ids) {
  markDirty(doc);
  const drop = new Set(ids);
  for (const id of drop) findEntity(doc, id);
  doc.entities = doc.entities.filter(e => !drop.has(e.id));
}

const MODIFIABLE = { CDataSen: ['start', 'end'], CDataMoji: ['at', 'text', 'height', 'width', 'angle'], CDataEnko: ['center', 'radius', 'startAngle', 'sweepAngle'], CDataTen: ['at'] };
export function modifyEntity(doc, id, set) {
  markDirty(doc);
  const e = findEntity(doc, id), p = e.props, s = scaleOf(doc, p.m_nGLayer), allowed = MODIFIABLE[e.cls] ?? fail('E_CODEC_KIND', `${id}:${e.kind}`);
  for (const key of Object.keys(set)) if (!allowed.includes(key)) fail('E_CODEC_MODIFY_FIELD', `${id}.${key}`);
  const file = v => [v[0] / s, v[1] / s];
  if (set.start) [p.m_start_x, p.m_start_y] = file(set.start);
  if (set.end) [p.m_end_x, p.m_end_y] = file(set.end);
  if (set.center) [p.m_start_x, p.m_start_y] = file(set.center);
  if (e.cls === 'CDataTen' && set.at) [p.m_start_x, p.m_start_y] = file(set.at);
  if (e.cls === 'CDataMoji') {
    if (set.at) { const [x, y] = file(set.at); p.m_end_x += x - p.m_start_x; p.m_end_y += y - p.m_start_y; p.m_start_x = x; p.m_start_y = y; }
    if (set.text !== undefined) p.m_string = set.text;
    if (set.height !== undefined) p.m_dSizeY = set.height;
    if (set.width !== undefined) p.m_dSizeX = set.width;
    if (set.angle !== undefined) p.m_degKakudo = set.angle;
    // Explicit sizes make the text 任意サイズ (type 0); keep the +10000/+20000 bold/italic flags.
    if (set.height !== undefined || set.width !== undefined) p.m_nMojiShu -= p.m_nMojiShu % 10000;
    if (['text', 'width', 'angle'].some(k => set[k] !== undefined)) updateTextEnd(p);
  }
  if (e.cls === 'CDataEnko') {
    if (set.radius !== undefined) p.m_dHankei = set.radius / s;
    if (set.startAngle !== undefined || set.sweepAngle !== undefined)
      arcAngles(p, set.startAngle ?? p.m_radKaishiKaku / DEG, set.sweepAngle ?? (p.m_bZenEnFlg ? 360 : p.m_radEnkoKaku / DEG));
  }
  checkFinite(p, id);
  return e;
}

// A group change keeps model-mm geometry by rescaling file coordinates; blocks/dimensions are refused then.
export function setEntityLayer(doc, id, layer) {
  markDirty(doc);
  const e = findEntity(doc, id), [g, l] = parseLayer(layer), from = scaleOf(doc, e.props.m_nGLayer), to = scaleOf(doc, g);
  if (from !== to) {
    if (!['CDataSen', 'CDataEnko', 'CDataTen', 'CDataMoji', 'CDataSolid'].includes(e.cls)) fail('E_CODEC_SETLAYER_SCALE', `${id}:${e.kind}`);
    const k = from / to;
    eachPoint(e.cls, e.props, (x, y) => [x * k, y * k]);
    if (e.cls === 'CDataEnko') e.props.m_dHankei *= k;
  }
  e.props.m_nGLayer = g; e.props.m_nLayer = l;
  return e;
}

export function setEntityPen(doc, id, pen) {
  markDirty(doc);
  const e = findEntity(doc, id), p = e.props;
  if (e.cls === 'CDataMoji' && (pen.style !== undefined || pen.width !== undefined)) fail('E_CODEC_PEN', `${id}: text accepts color only`);
  // These fields change the serialized layout (symbol point / solid RGB), so they need explicit data.
  if (e.cls === 'CDataTen' && pen.style !== undefined && (pen.style === 100) !== (p.m_nPenStyle === 100)) fail('E_CODEC_PEN', `${id}: point style 100`);
  if (e.cls === 'CDataSolid' && pen.color !== undefined && (pen.color === 10) !== (p.m_nPenColor === 10)) fail('E_CODEC_PEN', `${id}: solid color 10`);
  if (pen.width !== undefined && doc.version < 351) fail('E_CODEC_PEN', `${id}: width needs version 351+`);
  if (pen.color !== undefined) p.m_nPenColor = pen.color;
  if (pen.style !== undefined) p.m_nPenStyle = pen.style;
  if (pen.width !== undefined) p.m_nPenWidth = pen.width;
  return e;
}

function nextId(doc, wanted) {
  const used = new Set(doc.entities.map(e => e.id));
  if (wanted) return used.has(wanted) ? fail('E_CODEC_TEMP_ID', wanted) : wanted;
  let i = doc.entities.length;
  while (used.has(`n${i}`)) i++;
  return `n${i}`;
}
function base(doc, layer, pen = {}) {
  const [g, l] = parseLayer(layer);
  const p = { m_lGroup: 0, m_nPenStyle: pen.style ?? 1, m_nPenColor: pen.color ?? 1, m_nPenWidth: pen.width ?? 0, m_nLayer: l, m_nGLayer: g, m_sFlg: 0 };
  if (doc.version < 351) delete p.m_nPenWidth;
  return [p, scaleOf(doc, g)];
}
const mostCommon = (values, fallback) => {
  const counts = new Map(); let best = fallback, n = 0;
  for (const v of values) { const c = (counts.get(v) ?? 0) + 1; counts.set(v, c); if (c > n) { n = c; best = v; } }
  return best;
};
/** Build a JwwEntity from a normalized Patch v2 entity (model mm). */
export function makeEntity(doc, entity, id) {
  const pen = entity.pen ?? {};
  if (entity.kind === 'point' && pen.style === 100) fail('E_CODEC_PEN', 'point style 100');
  const [p, s] = base(doc, entity.layer, entity.kind === 'text' ? { color: entity.color } : pen), file = v => [v[0] / s, v[1] / s];
  let cls;
  if (entity.kind === 'line') { cls = 'CDataSen'; [p.m_start_x, p.m_start_y] = file(entity.start); [p.m_end_x, p.m_end_y] = file(entity.end); }
  else if (entity.kind === 'point') { cls = 'CDataTen'; [p.m_start_x, p.m_start_y] = file(entity.at); p.m_bKariten = 0; }
  else if (entity.kind === 'arc') {
    cls = 'CDataEnko'; [p.m_start_x, p.m_start_y] = file(entity.center); p.m_dHankei = entity.radius / s;
    arcAngles(p, entity.startAngle, entity.sweepAngle); p.m_radKatamukiKaku = (entity.tilt ?? 0) * DEG; p.m_dHenpeiRitsu = entity.flatness ?? 1;
  } else if (entity.kind === 'text') {
    cls = 'CDataMoji';
    const h = doc.header, style = entity.style ?? null, k = style && style >= 1 ? style - 1 : null;
    [p.m_start_x, p.m_start_y] = file(entity.at);
    p.m_nMojiShu = style ?? (entity.height !== undefined || entity.width !== undefined ? 0 : h.m_nMojiShu);
    p.m_dSizeX = entity.width ?? (k !== null ? h.m_adMojiX[k] : h.m_dMojiSizeX);
    p.m_dSizeY = entity.height ?? (k !== null ? h.m_adMojiY[k] : h.m_dMojiSizeY);
    p.m_dKankaku = entity.spacing ?? (k !== null ? h.m_adMojiD[k] : h.m_dMojiKankaku);
    p.m_degKakudo = entity.angle ?? 0;
    p.m_nPenColor = entity.color ?? (k !== null ? h.m_anMojiCol[k] : h.m_nMojiColor);
    p.m_strFontName = mostCommon(doc.entities.filter(e => e.cls === 'CDataMoji').map(e => e.props.m_strFontName), 'ＭＳ ゴシック');
    p.m_string = entity.text;
    updateTextEnd(p);
  } else fail('E_CODEC_KIND', entity.kind);
  checkFinite(p, id);
  return new JwwEntity(id, cls, p);
}
export function appendEntity(doc, entity, wantedId) {
  markDirty(doc);
  const e = entity instanceof JwwEntity ? entity : makeEntity(doc, entity, nextId(doc, wantedId));
  if (entity instanceof JwwEntity) e.id = nextId(doc, wantedId ?? e.id);
  doc.entities.push(e);
  return e;
}

/**
 * Apply normalized Patch v2 ops (from validatePatchV2) to a copy of `doc`.
 * Returns { doc, changes, idMap } where idMap maps tempIds to entity ids in the new doc.
 */
export function applyOps(doc, ops) {
  if (doc.partial) fail('E_JWW_CODEC_PARTIAL');
  if (!Array.isArray(ops)) fail('E_CODEC_OPS');
  const out = cloneDoc(doc), changes = [], idMap = {};
  for (const [i, op] of ops.entries()) {
    try {
      switch (op?.op) {
        case 'translate': for (const id of op.ids) translateEntity(out, idMap[id] ?? id, op.dx, op.dy); break;
        case 'delete': deleteEntities(out, op.ids.map(id => idMap[id] ?? id)); break;
        case 'modify': modifyEntity(out, idMap[op.id] ?? op.id, op.set); break;
        case 'setLayer': for (const id of op.ids) setEntityLayer(out, idMap[id] ?? id, op.layer); break;
        case 'setPen': for (const id of op.ids) setEntityPen(out, idMap[id] ?? id, op.pen); break;
        case 'add': { const e = appendEntity(out, op.entity, op.tempId); if (op.tempId) idMap[op.tempId] = e.id; changes.push({ op: 'add', id: e.id, kind: e.kind }); continue; }
        default: fail('E_CODEC_OP', String(op?.op));
      }
    } catch (error) { if (error.code) error.detail = `ops[${i}]${error.detail ? ` ${error.detail}` : ''}`; throw error; }
    changes.push({ op: op.op, ids: op.ids ?? [op.id] });
  }
  return { doc: out, changes, idMap };
}
