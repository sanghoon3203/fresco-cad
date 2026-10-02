// Tiered verification of JWW edits (docs/jw-assistant/verification.md).
//   L1  patch schema + engine pre-checks                       ~1 ms       every proposal
//   L2  pure-JS codec checks of the output bytes               tens of ms  every proposal (preview)
//   L3  independent JwwHelper DLL re-read vs the planned state  ~1 s       accept / save (file finalized only if it passes)
//   L4  real Jw_cad opens the file (tools/jw-regress.mjs)      tens of s   regression corpus, not per edit
// Every level returns { level, ok, durationMs, checks: [{ id, ok, detail }] }.
import { decodeJww, encodeJww, layersOf, SPAN } from './codec/jww-codec.mjs';
import { Writer } from './codec/archive.mjs';
import { validatePatchV2 } from '../core/patch-v2.mjs';
import { sharedWorker, workerEnabled, withTempFile, isWorkerInfraError, entityDigest, blocksDigest } from './jww-worker.mjs';

const rad = d => d * Math.PI / 180;
const round = ms => Math.round(ms * 10) / 10;
const DETAIL = 600;
const short = text => (text === null || text === undefined ? null : String(text).slice(0, DETAIL));

/** Run `body(check)`; a thrown error becomes a failed check and is returned (not thrown) as `error`. */
export async function runLevel(level, body) {
  const t0 = performance.now(), checks = [];
  const check = (id, ok, detail = null) => { checks.push({ id, ok: !!ok, detail: short(detail) }); return !!ok; };
  let error = null;
  try { await body(check); } catch (e) { error = e; checks.push({ id: e.checkId ?? 'exception', ok: false, detail: short(`${e.code ?? 'Error'}: ${e.detail ?? e.message}`) }); }
  const result = { level, ok: !error && checks.every(c => c.ok), durationMs: round(performance.now() - t0), checks };
  return { result, error };
}
export const summarize = results => results.map(({ level, ok, durationMs }) => ({ level, ok, durationMs }));
export const failedChecks = result => result.checks.filter(c => !c.ok).map(c => `${c.id}${c.detail ? `: ${c.detail}` : ''}`).join('; ');

// ---- L1 --------------------------------------------------------------------------------------------------------------
/**
 * Patch v2 validation plus engine pre-checks. `prechecks` = [[id, () => detail]] run in order (each may throw).
 * Returns { result, error, normalized }.
 */
export async function verifyL1(patch, ir, { prechecks = [] } = {}) {
  let normalized = null;
  const { result, error } = await runLevel('L1', async check => {
    try { normalized = validatePatchV2(patch, ir); } catch (e) { e.checkId = 'patch-v2'; throw e; }
    check('patch-v2', true, `${normalized.ops.length} op(s)`);
    for (const [id, fn] of prechecks) { try { check(id, true, await fn(normalized)); } catch (e) { e.checkId = id; throw e; } }
  });
  return { result, error, normalized };
}

// ---- codec view in the DLL reader's shape ------------------------------------------------------------------------------
// Field widths as exposed by JwwHelper (Int16 / Int32); the codec stores the file's unsigned words.
const I16 = new Set(['m_sFlg', 'm_nGLayer', 'm_nLayer', 'm_nPenWidth', 'm_nPenColor', 'm_bSxfMode']);
const I32 = new Set(['m_lGroup', 'm_nMojiShu', 'm_bZenEnFlg', 'm_bKariten', 'm_nCode', 'm_Color', 'm_nNumber']);
const BASE = ['m_lGroup', 'm_nPenStyle', 'm_nPenColor', 'm_nPenWidth', 'm_nLayer', 'm_nGLayer', 'm_sFlg'];
const s16 = v => (v << 16) >> 16, s32 = v => v | 0;
function convertEntity(e, id, version, diagnostics) {
  const src = e.props, props = {};
  const names = e.cls === 'CDataSunpou' ? [...BASE, 'm_bSxfMode'] : Object.keys(src).filter(k => typeof src[k] !== 'object' || src[k] === null);
  for (const name of names) {
    let v = src[name];
    if (v === undefined) v = 0; // m_nPenWidth (< v351) / m_bSxfMode (< v420): the DLL reports 0
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) { diagnostics.push({ code: 'NONFINITE_FIELD', entityId: id, field: name }); v = null; }
      else if (I16.has(name)) v = s16(v);
      else if (I32.has(name)) v = s32(v);
      else if (v === 0) v = 0; // -0 -> 0, as the DLL reader reports it
    }
    props[name] = v;
  }
  let record = null;
  if (e.cls === 'CDataSen' && version >= 351) {
    const b = Buffer.alloc(47);
    b.writeInt32LE(props.m_lGroup, 0); b.writeUInt8(props.m_nPenStyle & 0xff, 4);
    ['m_nPenColor', 'm_nPenWidth', 'm_nLayer', 'm_nGLayer', 'm_sFlg'].forEach((k, i) => b.writeInt16LE(props[k], 5 + i * 2));
    ['m_start_x', 'm_start_y', 'm_end_x', 'm_end_y'].forEach((k, i) => b.writeDoubleLE(src[k], 15 + i * 8));
    record = b.toString('base64');
  }
  const out = { id, type: e.type, props, record };
  if (e.cls === 'CDataSunpou') {
    const part = (cls, p, suffix) => convertEntity({ cls, type: cls === 'CDataSen' ? 'JwwSen' : 'JwwMoji', props: p }, `${id}/${suffix}`, version, diagnostics);
    out.components = [part('CDataSen', src.m_Sen, 'line'), part('CDataMoji', src.m_Moji, 'text')];
    diagnostics.push({ code: 'DIMENSION_AUXILIARY_UNAVAILABLE', entityId: id });
  }
  return out;
}
/**
 * The pure-JS codec's decoded document in the shape of native/jww.mjs readJww() (ids, prop names and widths, records,
 * dimension components, blocks, diagnostics). Differences to the DLL: strings are exact (the DLL turns non-CP932
 * characters of Unicode CStrings into '?'), and nothing here comes from JwwHelper.
 */
export function codecDocument(doc) {
  if (doc.partial) throw Object.assign(new Error('E_JWW_CODEC_PARTIAL'), { code: 'E_JWW_CODEC_PARTIAL', detail: doc.partial.message });
  const diagnostics = [];
  const entities = doc.entities.map((e, i) => convertEntity(e, `e${i}`, doc.version, diagnostics));
  const blocks = doc.blocks.map((b, k) => ({ id: `b${k}`, number: b.props.m_nNumber, name: b.props.m_strName, declaredCount: b.children.length,
    entities: b.children.map((c, i) => convertEntity(c, `b${k}/e${i}`, doc.version, diagnostics)) }));
  return { readerSchemaVersion: 2, version: doc.version, layers: layersOf(doc).map(({ id, groupName, name, scale, state }) => ({ id, groupName, name, scale, state })),
    entities, blockDefinitions: doc.blocks.length, blocks, images: doc.images?.length ?? 0,
    imageMetadata: (doc.images ?? []).map(i => ({ name: i.name, compressedBytes: i.data.length })), diagnostics };
}

// ---- semantic comparison (shared by L2 on codec views and L3 on DLL reads) ----------------------------------------------
const HEADER_ALLOWED = new Set(['m_jwwDataVersion', 'm_dEye_H_Ichi_1', 'm_dEye_H_Ichi_2', 'm_dEye_H_Ichi_3']);
export { HEADER_ALLOWED };
const TAU = 2 * Math.PI;
const isHalf = ch => { const c = ch.codePointAt(0); return c < 0x80 || (c >= 0xff61 && c <= 0xff9f); };
/** Jw_cad text extent: half-width chars are sizeX/2 and get half the spacing; `uniformSpacing` = full spacing everywhere. */
export function textWidth(string, sizeX, kankaku, { uniformSpacing = false } = {}) {
  const chars = [...string]; let width = 0, gaps = 0;
  chars.forEach((ch, i) => { const half = isHalf(ch); width += half ? sizeX / 2 : sizeX; if (i < chars.length - 1) gaps += half && !uniformSpacing ? 0.5 : 1; });
  return width + kankaku * gaps;
}
/** Accepted text extent range: between the half-spacing rule and the uniform-spacing rule (either order: spacing may be negative). */
export function textExtentRange(string, sizeX, kankaku) {
  const a = textWidth(string, sizeX, kankaku), b = textWidth(string, sizeX, kankaku, { uniformSpacing: true });
  return [Math.min(a, b), Math.max(a, b)];
}
const close = (a, b, tol) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)));
function endOk(g) {
  const dx = g.m_end_x - g.m_start_x, dy = g.m_end_y - g.m_start_y, a = rad(g.m_degKakudo), len = Math.hypot(dx, dy);
  const along = dx * Math.cos(a) + dy * Math.sin(a), across = -dx * Math.sin(a) + dy * Math.cos(a), [lo, hi] = textExtentRange(g.m_string, g.m_dSizeX, g.m_dKankaku);
  const tol = 1e-9 * Math.max(1, Math.abs(g.m_start_x), Math.abs(g.m_start_y), len);
  return Math.abs(across) <= tol && along >= lo - tol && along <= hi + tol;
}
const sameAngle = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(((((a - b) % TAU) + TAU + 1e-9) % TAU) - 1e-9) <= 1e-9;
/**
 * Compare a re-read document with the expected state planned by planNativeOps. `codec` mode: the header must be identical
 * (no DLL quirks allowed), touched geometry is compared to 1e-12 and approximate text ends / equivalent arc start angles are
 * accepted. Returns up to 12 problem strings.
 */
export function verifyRewrite(before, expected, after, { headerBefore, headerAfter, codec = false } = {}) {
  const problems = [], add = text => { if (problems.length < 12) problems.push(text); };
  for (const key of ['layers', 'blocks', 'imageMetadata']) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) add(`${key} changed`);
  if (before.blockDefinitions !== after.blockDefinitions || before.images !== after.images) add('block/image count changed');
  if (codec ? after.version !== before.version : !(after.version >= before.version)) add(`version ${before.version} -> ${after.version}`);
  if (after.entities.length !== expected.length) add(`entity count ${after.entities.length}, expected ${expected.length}`);
  const newIds = new Map();
  expected.forEach((item, i) => { if (item.from) newIds.set(item.from, { id: `e${i}`, touched: item.touched }); });
  expected.forEach((item, i) => {
    const got = after.entities[i], where = `e${i}${item.from ? `(was ${item.from})` : '(added)'}`;
    if (!got) return;
    if (got.type !== item.type) return add(`${where} type ${got.type}, expected ${item.type}`);
    const names = new Set([...Object.keys(item.props), ...Object.keys(got.props)]), loose = codec && item.touched;
    for (const name of names) {
      const a = got.props[name] ?? null, b = item.props[name] ?? null;
      if ((name in got.props) !== (name in item.props)) { add(`${where}.${name} present=${name in got.props}, expected ${name in item.props}`); continue; }
      if (a === b) continue;
      if (loose && item.endApprox && (name === 'm_end_x' || name === 'm_end_y')) continue;
      if (loose && close(a, b, 1e-12)) continue;
      if (loose && item.type === 'JwwEnko' && name === 'm_radKaishiKaku' && sameAngle(a, b)) continue;
      add(`${where}.${name} = ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
    }
    if (loose && item.endApprox && !endOk(got.props)) add(`${where} text end (${got.props.m_end_x}, ${got.props.m_end_y}) is not on the baseline with a Jw_cad-like length`);
    if (item.from && !item.touched && JSON.stringify(got.components) !== JSON.stringify(item.components)) add(`${where} components changed`);
  });
  const fixId = d => { if (!d.entityId) return d; const [root, ...rest] = d.entityId.split('/'), n = newIds.get(root); return n && !n.touched ? { ...d, entityId: [n.id, ...rest].join('/') } : null; };
  const untouched = new Set([...newIds.values()].filter(n => !n.touched).map(n => n.id));
  const wanted = (before.diagnostics ?? []).map(fixId).filter(Boolean).map(d => JSON.stringify(d)).sort();
  const got = (after.diagnostics ?? []).filter(d => !d.entityId || untouched.has(d.entityId.split('/')[0])).map(d => JSON.stringify(d)).sort();
  if (JSON.stringify(wanted) !== JSON.stringify(got)) add('diagnostics changed');
  if (headerBefore && headerAfter) {
    for (const name of new Set([...Object.keys(headerBefore), ...Object.keys(headerAfter)])) {
      if (name === 'acp' || (!codec && HEADER_ALLOWED.has(name))) continue;
      if (JSON.stringify(headerBefore[name]) !== JSON.stringify(headerAfter[name])) add(`header ${name} changed`);
    }
  }
  return problems;
}

// ---- byte-level checks -------------------------------------------------------------------------------------------------
/** Length of the MFC tag at `at`: new class (FFFF schema len name), big pid (7FFF + DWORD) or 16-bit pid. */
export function tagLength(buf, at) {
  const w = buf.readUInt16LE(at);
  if (w === 0xffff) return 6 + buf.readUInt16LE(at + 4);
  return w === 0x7fff ? 6 : 2;
}
// Bytes of [from, to) with the tag of every record (pre-order, nested block children included) removed.
function untagged(buf, roots, from, to) {
  const parts = []; let at = from;
  const visit = e => { const [s] = e[SPAN]; parts.push(buf.subarray(at, s)); at = s + tagLength(buf, s); for (const c of e.children ?? []) visit(c); };
  roots.forEach(visit); parts.push(buf.subarray(at, to));
  return Buffer.concat(parts);
}
/**
 * Are the header, every untouched entity record and everything after the entity list (blocks, images, trailer) unchanged,
 * ignoring MFC class tags (whose PIDs legitimately renumber after a structural change; L2 checks them separately)?
 * null = not checkable (partial decode). Entities are matched through the plan's `from` ids.
 */
export function byteExactOutsideEdits(bytes, output, expected, { source, decoded } = {}) {
  const a = source ?? decodeJww(bytes), b = decoded ?? decodeJww(output);
  if (a.partial || b.partial) return null;
  return outsideEditProblems(bytes, output, expected, a, b).length === 0;
}
function outsideEditProblems(bytes, output, expected, a, b) {
  const problems = [];
  if (Buffer.compare(bytes.subarray(...a.spans.header), output.subarray(...b.spans.header)) !== 0) problems.push('header bytes changed');
  if (Buffer.compare(untagged(bytes, a.blocks, a.spans.blocks[0], bytes.length), untagged(output, b.blocks, b.spans.blocks[0], output.length)) !== 0) problems.push('blocks/images/trailer bytes changed');
  const body = (buf, e) => { const [from, to] = e[SPAN]; return buf.subarray(from + tagLength(buf, from), to); };
  for (const [i, item] of expected.entries()) {
    if (!item.from || item.touched) continue;
    const src = a.entities[Number(item.from.slice(1))], out = b.entities[i];
    if (!src || !out) { problems.push(`e${i} missing`); continue; }
    if (Buffer.compare(body(bytes, src), body(output, out)) !== 0 && problems.push(`untouched e${i} (was ${item.from}) record bytes changed`) >= 8) break;
  }
  return problems;
}
/**
 * The output's class tags must be exactly the canonical MFC CArchive sequence for its record classes (pre-order, PIDs shared
 * by classes and objects, big-PID form from 0x7FFF), with the source file's class schemas. Catches spliced/renumbered tags.
 */
export function classTagProblems(output, decoded, schemas) {
  const values = Object.values(schemas), fallback = values[0] ?? Math.min(decoded.version, 0xffff), w = new Writer(1 << 16), problems = [];
  let records = 0;
  const visit = e => {
    const start = w.o; w.beginObject(e.cls, schemas[e.cls] ?? fallback);
    const want = w.b.subarray(start, w.o), [s] = e[SPAN], got = output.subarray(s, s + want.length);
    records++;
    if (!got.equals(want) && problems.length < 5) problems.push(`${e.id} (${e.cls}) tag at ${s}: ${got.toString('hex')}, canonical ${want.toString('hex')}`);
    for (const c of e.children ?? []) visit(c);
  };
  decoded.entities.forEach(visit); decoded.blocks.forEach(visit);
  return { problems, records };
}

// ---- L2 ----------------------------------------------------------------------------------------------------------------
/**
 * Codec-level verification of `outputBytes` against `plan` (planNativeOps on the codec view of the source).
 * Options: source = decodeJww(sourceBytes) and sourceView = codecDocument(source) if already computed; prior = checks to prepend (e.g. the apply step).
 */
export async function verifyL2(sourceBytes, outputBytes, plan, { source, sourceView, prior = [] } = {}) {
  return runLevel('L2', check => {
    for (const c of prior) check(c.id, c.ok, c.detail);
    const a = source ?? decodeJww(sourceBytes);
    if (!check('source-decode', !a.partial, a.partial?.message ?? `${a.entities.length} entities`)) return;
    const b = decodeJww(outputBytes);
    if (!check('output-decode', !b.partial, b.partial?.message ?? `${b.entities.length} entities, ${b.blocks.length} blocks`)) return;
    const again = encodeJww(b);
    check('reencode-stable', Buffer.compare(again, outputBytes) === 0, `${outputBytes.length} bytes`);
    const tags = classTagProblems(outputBytes, b, a.schemas);
    check('class-tags', tags.problems.length === 0, tags.problems.length ? tags.problems.join('; ') : `${tags.records} records canonical`);
    const outside = outsideEditProblems(sourceBytes, outputBytes, plan.expected, a, b);
    const untouched = plan.expected.filter(i => i.from && !i.touched).length;
    check('byte-exact-outside-edits', outside.length === 0, outside.length ? outside.join('; ') : `header, ${untouched} untouched records, blocks/images identical`);
    const problems = verifyRewrite(sourceView ?? codecDocument(a), plan.expected, codecDocument(b), { codec: true });
    const touched = plan.expected.filter(i => i.touched).length;
    check('semantic', problems.length === 0, problems.length ? problems.join('; ') : `${touched} touched/added entities match the plan`);
  });
}

// ---- L3 ----------------------------------------------------------------------------------------------------------------
const PLACEHOLDER = '0'.repeat(16);
const standIn = (item, i) => ({ id: `e${i}`, type: item.type, props: item.props, record: null, ...(item.components ? { components: item.components } : {}) });
/**
 * DLL re-read of `outputBytes` for comparison with `expected`: through the worker only touched/added entities and entities
 * whose canonical digest differs are shipped; the others are represented by their (digest-identical) expected record.
 * Returns { document, header, reader, shipped, mismatches }.
 */
export async function dllReadForVerify(outputBytes, expected, before, { fallback } = {}) {
  if (workerEnabled()) {
    const digests = expected.map(item => (item.touched || !item.from ? PLACEHOLDER : entityDigest(item))).join('');
    const full = expected.flatMap((item, i) => (item.touched || !item.from ? [i] : []));
    try {
      const res = await withTempFile(outputBytes, file => sharedWorker().request('verify', { path: file, digests, full, maxShipped: 2000 }));
      const doc = res.document, shipped = doc.shipped ?? {};
      const entities = Array.from({ length: doc.entityCount }, (_, i) => shipped[i] ?? (expected[i] ? standIn(expected[i], i) : { id: `e${i}`, type: '?', props: {} }));
      const blocks = doc.blocksDigest === blocksDigest(before.blocks) ? before.blocks : [{ id: 'digest-mismatch', digest: doc.blocksDigest, count: doc.blockCount }];
      const shippedCount = Object.keys(shipped).length;
      const document = { ...doc, entities, blocks }; for (const k of ['shipped', 'entityCount', 'digestMismatches', 'blocksDigest', 'blockCount']) delete document[k];
      return { document, header: res.header, reader: 'worker', shipped: shippedCount, mismatches: doc.digestMismatches, unshippedMismatches: Math.max(0, doc.digestMismatches - (shippedCount - full.filter(i => i < doc.entityCount).length)) };
    } catch (error) {
      if (!isWorkerInfraError(error) || !fallback) throw error;
    }
  }
  if (!fallback) throw Object.assign(new Error('E_JWW_WORKER_UNAVAILABLE'), { code: 'E_JWW_WORKER_UNAVAILABLE' });
  const { document, header } = await fallback(outputBytes);
  return { document, header, reader: 'oneshot', shipped: document.entities.length, mismatches: null, unshippedMismatches: 0 };
}
/**
 * Independent DLL verification: re-read the output with JwwHelper and compare with the state planned from the DLL read of
 * the source. Options: before (DLL document of the source), headerBefore, codec (false for the DLL writer), fallback(bytes)
 * -> { document, header } one-shot reader used when the worker is unavailable.
 */
export async function verifyL3(outputBytes, plan, { before, headerBefore, codec = true, fallback } = {}) {
  return runLevel('L3', async check => {
    const read = await dllReadForVerify(outputBytes, plan.expected, before, { fallback });
    check('dll-reread', true, `${read.reader}: ${read.document.entities.length} entities, ${read.shipped} shipped${read.mismatches !== null ? `, ${read.mismatches} digest mismatches` : ''}`);
    const problems = verifyRewrite(before, plan.expected, read.document, { headerBefore, headerAfter: read.header, codec });
    if (read.unshippedMismatches > 0) problems.unshift(`${read.unshippedMismatches} more entities differ from the plan (not shipped)`);
    check('dll-vs-plan', problems.length === 0, problems.length ? problems.join('; ') : 'entities, layers, blocks, images, diagnostics and header match');
  });
}
