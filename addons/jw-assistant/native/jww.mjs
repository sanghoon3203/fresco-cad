import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const fail = code => { throw Object.assign(new Error(code), { code }); };
export async function readJww(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > 32 * 1024 * 1024 || bytes.subarray(0, 8).toString('ascii') !== 'JwwData.') fail('E_JWW_FORMAT');
  const folder = await mkdtemp(path.join(tmpdir(), 'fresco-jww-'));
  const input = path.join(folder, 'source.jww'), output = path.join(folder, 'document.json');
  try {
    await writeFile(input, bytes, { flag: 'wx' });
    await execute(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./Read-Jww.ps1', import.meta.url)), '-InputPath', input, '-OutputPath', output],
      { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
    const document = JSON.parse(await readFile(output, 'utf8'));
    if (!Array.isArray(document.entities) || !Array.isArray(document.layers) || document.entities.length > 100000) fail('E_JWW_DOCUMENT');
    return document;
  } catch (error) { fail(error.code?.startsWith('E_JWW_') ? error.code : 'E_JWW_NATIVE_READ'); }
  finally { for (const file of [input, output]) await unlink(file).catch(() => {}); await rmdir(folder).catch(() => {}); }
}

// Change only the 32 coordinate bytes of one uniquely located, native-decoded line.
// Ambiguous byte matches, non-line entities and old layouts remain uneditable.
export function patchLine(bytes, document, entityId, points) {
  if (!Array.isArray(points) || points.length !== 4 || !points.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e7)) fail('E_JWW_COORDINATES');
  const entity = document.entities.find(item => item.id === entityId);
  if (document.version < 351 || entity?.type !== 'JwwSen' || !entity.record || entity.props?.m_lGroup !== 0 || entity.props?.m_sFlg !== 0) fail('E_JWW_LINE_ONLY');
  const needle = Buffer.from(entity.record, 'base64');
  if (needle.length !== 47) fail('E_JWW_LAYOUT');
  const offset = bytes.indexOf(needle);
  if (offset < 0 || bytes.indexOf(needle, offset + 1) !== -1) fail('E_JWW_AMBIGUOUS_RECORD');
  const next = Buffer.from(bytes);
  for (let i = 0; i < 4; i++) next.writeDoubleLE(points[i], offset + 15 + i * 8);
  return { bytes: next, coordinateOffset: offset + 15 };
}

export function verifyLineEdit(before, after, entityId, points) {
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
