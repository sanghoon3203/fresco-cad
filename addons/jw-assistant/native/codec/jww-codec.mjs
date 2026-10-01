// Pure JS JWW codec. Byte-exact re-encoding: every field is re-serialized from the decoded record; strings
// and NaN doubles keep their original bytes while unchanged; class tags/PIDs are regenerated MFC-faithfully.
import { Reader, Writer, encodeCString, fail } from './archive.mjs';
import { HEADER, CLASSES } from './jww-schema.mjs';

export const RAW = Symbol('jww.raw');
// [tagOffset, endOffset, tagKind] of a record in the decoded source bytes; absent on created/cloned entities.
export const SPAN = Symbol('jww.span');
const SIGNATURE = 'JwwData.';
const raws = rec => rec[RAW] ??= new Map();
const keyOf = (name, idx) => idx.length ? `${name}[${idx.join('][')}]` : name;
const getAt = (rec, name, idx) => { let v = rec[name]; for (const i of idx) v = v?.[i]; return v; };
function putAt(rec, name, idx, value) {
  if (!idx.length) { rec[name] = value; return; }
  let a = rec[name] ??= [];
  for (let k = 0; k < idx.length - 1; k++) a = a[idx[k]] ??= [];
  a[idx.at(-1)] = value;
}
export const hex = n => n.toString(16).toUpperCase();

export class JwwEntity {
  constructor(id, cls, props, children) {
    this.id = id; this.cls = cls; this.type = CLASSES[cls].type; this.kind = CLASSES[cls].kind; this.props = props;
    if (children) this.children = children;
  }
  get layer() { return `${hex(this.props.m_nGLayer)}:${hex(this.props.m_nLayer)}`; }
  get pen() { const p = this.props; return { style: p.m_nPenStyle, color: p.m_nPenColor, width: p.m_nPenWidth ?? 0 }; }
  get geometry() { return geometryOf(this.cls, this.props); }
  toJSON() {
    const out = { id: this.id, kind: this.kind, type: this.type, layer: this.layer, pen: this.pen, geometry: this.geometry };
    if (this.children) Object.assign(out, { number: this.props.m_nNumber, name: this.props.m_strName, children: this.children.map(e => e.toJSON()) });
    return out;
  }
}
const pt = (p, x, y) => [p[x], p[y]];
function geometryOf(cls, p) {
  switch (cls) {
    case 'CDataSen': return { start: pt(p, 'm_start_x', 'm_start_y'), end: pt(p, 'm_end_x', 'm_end_y') };
    case 'CDataEnko': return { center: pt(p, 'm_start_x', 'm_start_y'), radius: p.m_dHankei, startRadians: p.m_radKaishiKaku, sweepRadians: p.m_radEnkoKaku,
      tiltRadians: p.m_radKatamukiKaku, flatness: p.m_dHenpeiRitsu, full: p.m_bZenEnFlg !== 0 };
    case 'CDataTen': return { at: pt(p, 'm_start_x', 'm_start_y'), temporary: p.m_bKariten !== 0, ...(p.m_nPenStyle === 100 ? { code: p.m_nCode, rotationRadians: p.m_radKaitenKaku, scale: p.m_dBairitsu } : {}) };
    case 'CDataMoji': return { at: pt(p, 'm_start_x', 'm_start_y'), end: pt(p, 'm_end_x', 'm_end_y'), text: p.m_string, font: p.m_strFontName,
      style: p.m_nMojiShu, width: p.m_dSizeX, height: p.m_dSizeY, spacing: p.m_dKankaku, angleDegrees: p.m_degKakudo };
    case 'CDataSunpou': return { line: geometryOf('CDataSen', p.m_Sen), text: geometryOf('CDataMoji', p.m_Moji), sxf: p.m_bSxfMode ?? null };
    case 'CDataSolid': return { points: [pt(p, 'm_start_x', 'm_start_y'), pt(p, 'm_end_x', 'm_end_y'), pt(p, 'm_DPoint2_x', 'm_DPoint2_y'), pt(p, 'm_DPoint3_x', 'm_DPoint3_y')],
      ...(p.m_nPenColor === 10 ? { rgb: p.m_Color } : {}) };
    case 'CDataBlock': return { at: pt(p, 'm_DPKijunTen_x', 'm_DPKijunTen_y'), scaleX: p.m_dBairitsuX, scaleY: p.m_dBairitsuY, rotationRadians: p.m_radKaitenKaku, number: p.m_nNumber };
    default: return null;
  }
}

function readSpec(spec, rec, r, ctx, idx = [], owner = null) {
  for (const node of spec) {
    const [t, a, b, c] = node;
    if (t === 'rep') for (let i = 0; i < a; i++) readSpec(b, rec, r, ctx, [...idx, i], owner);
    else if (t === 'if') readSpec(a(ctx, rec) ? b : c, rec, r, ctx, idx, owner);
    else if (t === 'obj') readSpec(b, rec[a] = {}, r, ctx);
    else if (t === 'list') owner.children = readList(r, ctx, `${owner.id}/e`);
    else if (t === 'str') { const s = r.cstring(); putAt(rec, a, idx, s.text); raws(rec).set(keyOf(a, idx), s); }
    else if (t === 'f64') {
      const at = r.o, value = r.f64();
      if (Number.isNaN(value)) { raws(rec).set(keyOf(a, idx), { nan: Buffer.from(r.b.subarray(at, at + 8)) }); ctx.diagnostics.push({ code: 'NAN_FIELD', field: keyOf(a, idx), offset: at }); }
      putAt(rec, a, idx, value);
    } else putAt(rec, a, idx, r[t]());
  }
}
function writeSpec(spec, rec, w, ctx, idx = [], owner = null) {
  for (const node of spec) {
    const [t, a, b, c] = node;
    if (t === 'rep') for (let i = 0; i < a; i++) writeSpec(b, rec, w, ctx, [...idx, i], owner);
    else if (t === 'if') writeSpec(a(ctx, rec) ? b : c, rec, w, ctx, idx, owner);
    else if (t === 'obj') writeSpec(b, rec[a], w, ctx);
    else if (t === 'list') writeList(w, owner.children, ctx);
    else {
      const value = getAt(rec, a, idx), raw = rec[RAW]?.get(keyOf(a, idx));
      if (t === 'str') {
        if (typeof value !== 'string') fail('E_JWW_FIELD', keyOf(a, idx));
        w.bytes(raw && raw.text === value ? raw.raw : encodeCString(value, { unicode: raw ? raw.unicode : ctx.preferUnicode }));
      } else if (t === 'f64') {
        if (typeof value !== 'number') fail('E_JWW_FIELD', keyOf(a, idx));
        if (Number.isNaN(value) && raw?.nan) w.bytes(raw.nan); else w.f64(value);
      } else {
        if (!Number.isInteger(value)) fail('E_JWW_FIELD', keyOf(a, idx));
        w[t](value);
      }
    }
  }
}

function readObject(r, ctx, id) {
  const at = r.o, tag = r.tag();
  if (tag.kind === 'null' || tag.kind === 'object') fail('E_JWW_UNSUPPORTED_TAG', `${tag.kind} at ${at}`);
  const def = CLASSES[tag.name];
  if (!def) fail('E_JWW_UNKNOWN_CLASS', `${tag.name} at ${at}`);
  if (tag.big) ctx.diagnostics.push({ code: 'BIG_PID_TAG', offset: at });
  if (!(tag.name in ctx.schemas)) ctx.schemas[tag.name] = tag.schema;
  r.registerObject(tag.name);
  const owner = { id }, props = {};
  readSpec(def.spec, props, r, ctx, [], owner);
  const entity = new JwwEntity(id, tag.name, props, owner.children);
  entity[SPAN] = [at, r.o, tag.kind];
  return entity;
}
function readList(r, ctx, prefix) {
  const n = r.count(), items = [];
  for (let i = 0; i < n; i++) items.push(readObject(r, ctx, `${prefix}${i}`));
  return items;
}
function writeList(w, items, ctx) {
  w.count(items.length);
  for (const e of items) {
    w.beginObject(e.cls, ctx.schemas[e.cls] ?? ctx.defaultSchema);
    writeSpec(CLASSES[e.cls].spec, e.props, w, ctx, [], e);
  }
}

/** Decode JWW bytes into an editable document that re-encodes byte-exactly. */
export function decodeJww(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) fail('E_JWW_FORMAT');
  bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  if (bytes.subarray(0, 8).toString('latin1') !== SIGNATURE) fail('E_JWW_FORMAT');
  const r = new Reader(bytes, 8), version = r.u32();
  const ctx = { version, diagnostics: [], schemas: {} };
  const doc = { format: 'jww', version, header: {}, entities: [], blocks: [], images: null, trailer: Buffer.alloc(0), schemas: ctx.schemas, diagnostics: ctx.diagnostics, spans: {}, sourceLength: bytes.length };
  try { readSpec(HEADER, doc.header, r, ctx); } catch (error) { fail('E_JWW_HEADER', error.message); }
  doc.spans.header = [8, r.o];
  try {
    let at = r.o;
    doc.entities = readList(r, ctx, 'e'); doc.spans.entities = [at, r.o]; at = r.o;
    doc.blocks = readList(r, ctx, 'b'); doc.spans.blocks = [at, r.o]; at = r.o;
    if (version >= 700 && r.o < bytes.length) {
      const n = r.u32(); doc.images = [];
      for (let i = 0; i < n; i++) {
        const image = {}, s = r.cstring(), size = r.u32();
        image.name = s.text; raws(image).set('name', s); image.data = Buffer.from(r.bytes(size));
        doc.images.push(image);
      }
      doc.spans.images = [at, r.o];
    }
    doc.trailer = Buffer.from(bytes.subarray(r.o));
    if (doc.trailer.length) ctx.diagnostics.push({ code: 'TRAILING_BYTES', offset: r.o, length: doc.trailer.length });
  } catch (error) {
    // Keep the original bytes so the document still round-trips; structural edits are refused.
    doc.partial = { offset: r.o, code: error.code ?? 'E_JWW_DECODE', message: error.message };
    doc.passthrough = Buffer.from(bytes);
    ctx.diagnostics.push({ code: 'PARTIAL_DECODE', offset: r.o, error: error.message });
  }
  doc.stringEncoding = stringEncoding(doc);
  return doc;
}
// New strings follow the drawing's text convention (newer Jw_cad writes Unicode CStrings); CP932 otherwise, Unicode when unencodable.
function stringEncoding(doc) {
  let unicode = 0, ansi = 0;
  for (const e of doc.entities) if (e.cls === 'CDataMoji') e.props[RAW].get('m_string').unicode ? unicode++ : ansi++;
  return unicode > ansi ? 'unicode' : 'cp932';
}

/** Encode a document produced by decodeJww (optionally mutated) back to JWW bytes. */
export function encodeJww(doc) {
  if (doc?.format !== 'jww' || !doc.header) fail('E_JWW_DOC');
  if (doc.partial) { if (doc.dirty) fail('E_JWW_CODEC_PARTIAL'); return Buffer.from(doc.passthrough); }
  const values = Object.values(doc.schemas);
  const ctx = { version: doc.version, schemas: doc.schemas, defaultSchema: values[0] ?? Math.min(doc.version, 0xffff), preferUnicode: doc.stringEncoding === 'unicode' };
  const w = new Writer(Math.max(1 << 16, (doc.sourceLength ?? 0) + 4096));
  w.bytes(Buffer.from(SIGNATURE, 'latin1')); w.u32(doc.version);
  writeSpec(HEADER, doc.header, w, ctx);
  writeList(w, doc.entities, ctx);
  writeList(w, doc.blocks, ctx);
  if (doc.images) {
    w.u32(doc.images.length);
    for (const image of doc.images) {
      const raw = image[RAW]?.get('name');
      w.bytes(raw && raw.text === image.name ? raw.raw : encodeCString(image.name, { unicode: ctx.preferUnicode })); w.u32(image.data.length); w.bytes(image.data);
    }
  }
  w.bytes(doc.trailer);
  return w.result();
}

/** New empty document: zero/empty header fields, scale 1 in every group, no entities. */
export function createJww({ version = 700, images = version >= 700 } = {}) {
  const zero = { o: 0, b: Buffer.alloc(8), u8: () => 0, u16: () => 0, u32: () => 0, i32: () => 0, f64: () => 0, cstring: () => ({ text: '', raw: Buffer.of(0), unicode: false }) };
  const ctx = { version, diagnostics: [], schemas: {} }, header = {};
  readSpec(HEADER, header, zero, ctx);
  header.m_adScale.fill(1);
  return { format: 'jww', version, header, entities: [], blocks: [], images: images ? [] : null, trailer: Buffer.alloc(0), schemas: {}, diagnostics: [], spans: {}, stringEncoding: 'cp932' };
}

export const layerKey = (g, l) => `${hex(g)}:${hex(l)}`;
export function layersOf(doc) {
  const h = doc.header, layers = [];
  for (let g = 0; g < 16; g++) for (let l = 0; l < 16; l++)
    layers.push({ id: layerKey(g, l), group: g, layer: l, name: h.m_aStrLayName[g][l], groupName: h.m_aStrGLayName[g], scale: h.m_adScale[g], state: h.m_aanLay[g][l], protect: h.m_aanLayProtect[g][l] });
  return layers;
}
/** JSON semantic view: stable ids, kind, layer "G:L", pen, file-unit geometry, block definitions with children. */
export function semanticView(doc) {
  return { version: doc.version, memo: doc.header.m_strMemo, layers: layersOf(doc), entities: doc.entities.map(e => e.toJSON()),
    blocks: doc.blocks.map(b => b.toJSON()), images: (doc.images ?? []).map(i => ({ name: i.name, size: i.data.length })),
    partial: doc.partial ?? null, diagnostics: doc.diagnostics };
}
