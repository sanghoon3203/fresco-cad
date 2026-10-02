import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { sharedWorker, workerEnabled, withTempFile, isWorkerInfraError } from './jww-worker.mjs';

const execute = promisify(execFile);
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const fail = code => { throw Object.assign(new Error(code), { code }); };
const checkDocument = document => { if (!Array.isArray(document?.entities) || !Array.isArray(document.layers) || document.entities.length > 100000) fail('E_JWW_DOCUMENT'); return document; };
// Last reader path used ('worker' | 'oneshot') and its duration; informational (benchmarks, receipts).
export const readerInfo = { path: null, ms: null, fallback: null };
/**
 * DLL (JwwHelper) read of a JWW. Uses the persistent worker (native/jww-worker.mjs) when available and falls back to the
 * one-shot PowerShell reader if the worker machinery fails. A genuine read error of the file is not retried.
 * FRESCO_JWW_WORKER=0 or { worker: false } forces the one-shot path.
 */
export async function readJww(bytes, { worker = true } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > 32 * 1024 * 1024 || bytes.subarray(0, 8).toString('ascii') !== 'JwwData.') fail('E_JWW_FORMAT');
  const t0 = performance.now();
  if (worker && workerEnabled()) {
    try {
      const document = checkDocument(await withTempFile(bytes, file => sharedWorker().request('read', { path: file })));
      Object.assign(readerInfo, { path: 'worker', ms: performance.now() - t0, fallback: null });
      return document;
    } catch (error) {
      if (!isWorkerInfraError(error)) fail(error.code === 'E_JWW_DOCUMENT' || error.code === 'E_JWW_ENTITY_LIMIT' ? 'E_JWW_DOCUMENT' : 'E_JWW_NATIVE_READ');
      readerInfo.fallback = error.code;
    }
  }
  const document = await readJwwOneShot(bytes);
  Object.assign(readerInfo, { path: 'oneshot', ms: performance.now() - t0 });
  return document;
}
/** The original one-shot reader: spawns PowerShell, loads .NET + the DLL and serializes the whole document per call. */
export async function readJwwOneShot(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > 32 * 1024 * 1024 || bytes.subarray(0, 8).toString('ascii') !== 'JwwData.') fail('E_JWW_FORMAT');
  const folder = await mkdtemp(path.join(tmpdir(), 'fresco-jww-'));
  const input = path.join(folder, 'source.jww'), output = path.join(folder, 'document.json');
  try {
    await writeFile(input, bytes, { flag: 'wx' });
    await execute(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./Read-Jww.ps1', import.meta.url)), '-InputPath', input, '-OutputPath', output],
      { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
    return checkDocument(JSON.parse(await readFile(output, 'utf8')));
  } catch (error) { fail(error.code?.startsWith('E_JWW_') ? error.code : 'E_JWW_NATIVE_READ'); }
  finally { for (const file of [input, output]) await unlink(file).catch(() => {}); await rmdir(folder).catch(() => {}); }
}

// toIR() calls patchLine once per line; two Buffer.indexOf scans each made that O(lines x file size) (~20 s for 21k
// entities). For a (bytes, document) pair this index finds every occurrence of every line record in one pass: candidate
// positions are those whose 8 bytes equal some record's m_start_x (a 32-bit prefilter, then an exact compare), which is
// exactly the set of positions where a full record can match. Results equal the indexOf semantics (unique match only).
const recordIndexes = new WeakMap();
function recordIndex(bytes, document) {
  if (!document || typeof document !== 'object' || (document.entities?.length ?? 0) < 64) return null;
  const cached = recordIndexes.get(document);
  if (cached && cached.bytes === bytes && cached.length === bytes.length) return cached;
  const byId = new Map(), wanted = new Map(), hits = new Map(), lows = new Set();
  for (const e of document.entities) {
    byId.set(e.id, e);
    if (e.type !== 'JwwSen' || typeof e.record !== 'string' || hits.has(e.record)) continue;
    const needle = Buffer.from(e.record, 'base64'); if (needle.length !== 47) continue;
    const key = needle.toString('latin1', 15, 23);
    hits.set(e.record, { first: -1, count: 0 });
    (wanted.get(key) ?? wanted.set(key, []).get(key)).push([e.record, needle]);
    lows.add(needle.readUInt32LE(15));
  }
  for (let p = 15, end = bytes.length - 32; p <= end; p++) {
    if (!lows.has(bytes.readUInt32LE(p))) continue;
    const list = wanted.get(bytes.toString('latin1', p, p + 8)); if (!list) continue;
    for (const [record, needle] of list) {
      if (bytes.compare(needle, 0, 47, p - 15, p + 32) !== 0) continue;
      const hit = hits.get(record); if (hit.count === 0) hit.first = p - 15; hit.count++;
    }
  }
  const index = { bytes, length: bytes.length, byId, hits };
  recordIndexes.set(document, index);
  return index;
}

// Change only the 32 coordinate bytes of one uniquely located, native-decoded line.
// Ambiguous byte matches, non-line entities and old layouts remain uneditable.
export function patchLine(bytes, document, entityId, points) {
  if (!Array.isArray(points) || points.length !== 4 || !points.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e7)) fail('E_JWW_COORDINATES');
  const index = recordIndex(bytes, document);
  const entity = index ? index.byId.get(entityId) : document.entities.find(item => item.id === entityId);
  if (document.version < 351 || entity?.type !== 'JwwSen' || !entity.record || entity.props?.m_lGroup !== 0 || entity.props?.m_sFlg !== 0) fail('E_JWW_LINE_ONLY');
  const needle = Buffer.from(entity.record, 'base64');
  if (needle.length !== 47) fail('E_JWW_LAYOUT');
  let offset;
  if (index?.hits.has(entity.record)) { const hit = index.hits.get(entity.record); offset = hit.count === 1 ? hit.first : -1; }
  else { offset = bytes.indexOf(needle); if (offset >= 0 && bytes.indexOf(needle, offset + 1) !== -1) offset = -1; }
  if (offset < 0 || !bytes.subarray(offset, offset + 47).equals(needle)) fail('E_JWW_AMBIGUOUS_RECORD');
  // The patched copy is made on first access: toIR() only probes editability and never reads it (a 1 MB copy per line).
  let next = null;
  return { get bytes() {
    if (!next) { next = Buffer.from(bytes); for (let i = 0; i < 4; i++) next.writeDoubleLE(points[i], offset + 15 + i * 8); }
    return next;
  }, coordinateOffset: offset + 15 };
}

export function verifyLineEdit(before, after, entityId, points) {
  for (const key of ['blocks', 'imageMetadata', 'diagnostics']) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) fail('E_JWW_REOPEN_MISMATCH');
  }
  if (before.version !== after.version || before.blockDefinitions !== after.blockDefinitions || before.images !== after.images
    || JSON.stringify(before.layers) !== JSON.stringify(after.layers) || before.entities.length !== after.entities.length) fail('E_JWW_REOPEN_MISMATCH');
  const fields = ['m_start_x', 'm_start_y', 'm_end_x', 'm_end_y'];
  for (let index = 0; index < before.entities.length; index++) {
    const old = before.entities[index], next = after.entities[index];
    if (old.id !== entityId) { if (JSON.stringify(old) !== JSON.stringify(next)) fail('E_JWW_REOPEN_MISMATCH'); continue; }
    if (next.type !== old.type || next.id !== old.id) fail('E_JWW_REOPEN_MISMATCH');
    for (const [name, value] of Object.entries(old.props)) {
      const i = fields.indexOf(name), expected = i < 0 ? value : points[i];
      if (typeof expected === 'number' ? !Number.isFinite(next.props[name]) || Math.abs(next.props[name] - expected) > Math.max(1, Math.abs(expected)) * 1e-14 : next.props[name] !== expected) fail('E_JWW_REOPEN_MISMATCH');
    }
  }
}

export function observeRules(document, sourceHash) {
  const layers = new Map(), types = {};
  for (const entity of document.entities) {
    types[entity.type] = (types[entity.type] ?? 0) + 1;
    const p = entity.props, id = `${p.m_nGLayer.toString(16).toUpperCase()}:${p.m_nLayer.toString(16).toUpperCase()}`;
    const entry = layers.get(id) ?? { id, count: 0, lineCount: 0, colors: {}, styles: {}, textHeights: {}, examples: [] };
    entry.count++;
    for (const [field, value] of [['colors', p.m_nPenColor], ['styles', p.m_nPenStyle]]) entry[field][value] = (entry[field][value] ?? 0) + 1;
    if (entity.type === 'JwwSen') entry.lineCount++;
    if (entity.type === 'JwwMoji') {
      const height = String(p.m_dSizeY); entry.textHeights[height] = (entry.textHeights[height] ?? 0) + 1;
      if (entry.examples.length < 3 && typeof p.m_string === 'string') entry.examples.push(p.m_string.slice(0, 120));
    }
    layers.set(id, entry);
  }
  const observations = [...layers.values()].map(entry => ({ ...entry, ...document.layers.find(layer => layer.id === entry.id) }));
  const candidates = observations.map(entry => ({ id: `layer-${entry.id}`, kind: 'layer-convention', layerId: entry.id,
    allowedColors: Object.keys(entry.colors).map(Number), allowedStyles: Object.keys(entry.styles).map(Number), textHeights: Object.keys(entry.textHeights).map(Number),
    evidenceCount: entry.count, status: 'proposal', explanation: 'Observed in this drawing only; review before adopting as an office convention.' }));
  return { schemaVersion: 1, sourceHash, scope: 'top-level entities; blocks and embedded images not expanded', types, observations, candidates };
}
