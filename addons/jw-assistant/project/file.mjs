import { importJwcTemp } from '../jw-adapter/importer.mjs';
import { verifyCapturePair } from '../jw-adapter/capture-bundle.mjs';
import { validateWorkspace } from '../review/store.mjs';
import { validateFieldWorkspace } from '../field/standards.mjs';

export const MAX_PROJECT_BYTES = 16 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== keys.sort().join('|')) fail('E_PROJECT_SCHEMA');
}
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || !value.isWellFormed()
    || /[\u0000-\u001f\u007f/\\]/u.test(value)) fail('E_PROJECT_NAME');
}
export function encodeBytes(bytes) {
  let value = '';
  for (let start = 0; start < bytes.length; start += 8192) value += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(value);
}
function decodeBytes(value, limit) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(limit / 3) * 4
    || value.length % 4 || /[^A-Za-z0-9+/=]/u.test(value)) fail('E_PROJECT_BYTES');
  let bytes;
  try { bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0)); } catch { fail('E_PROJECT_BYTES'); }
  if (bytes.length > limit || encodeBytes(bytes) !== value) fail('E_PROJECT_BYTES');
  return bytes;
}
export async function hashBytes(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function serializeProject(value) {
  const raw = JSON.stringify(value);
  if (new TextEncoder().encode(raw).length > MAX_PROJECT_BYTES) fail('E_PROJECT_LIMIT');
  return raw;
}

// Validate in isolation before the UI swaps sessions. Derived geometry is never serialized.
export async function parseProject(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_PROJECT_BYTES || new TextEncoder().encode(raw).length > MAX_PROJECT_BYTES) fail('E_PROJECT_LIMIT');
  let project;
  try { project = JSON.parse(raw); } catch { fail('E_PROJECT_JSON'); }
  exact(project, ['format', 'schemaVersion', 'id', 'name', 'savedAt', 'capture', 'review', 'field']);
  if (project.format !== 'fresco-jw-project' || project.schemaVersion !== 1) fail('E_PROJECT_SCHEMA');
  if (typeof project.id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(project.id)) fail('E_PROJECT_ID');
  name(project.name);
  if (typeof project.savedAt !== 'string' || !Number.isFinite(Date.parse(project.savedAt))
    || new Date(project.savedAt).toISOString() !== project.savedAt) fail('E_PROJECT_TIME');
  const capture = project.capture;
  exact(capture, ['name', 'sha256', 'base64', 'metadataBase64', 'encoding', 'coordinateMode', 'group']);
  name(capture.name);
  if (!['utf-8', 'shift_jis'].includes(capture.encoding) || !['paper-mm', 'model-mm'].includes(capture.coordinateMode)
    || typeof capture.group !== 'string' || !/^[0-9A-F]$/u.test(capture.group)) fail('E_PROJECT_OPTIONS');
  const bytes = decodeBytes(capture.base64, 8 * 1024 * 1024);
  if (typeof capture.sha256 !== 'string' || capture.sha256 !== await hashBytes(bytes)) fail('E_PROJECT_HASH');
  const metadata = capture.metadataBase64 === null ? null : decodeBytes(capture.metadataBase64, 64 * 1024);
  const verification = metadata ? await verifyCapturePair(bytes, metadata) : null;
  validateWorkspace(project.review); validateFieldWorkspace(project.field);
  const result = await importJwcTemp(bytes, { encoding: capture.encoding, selectedGroup: capture.group,
    calibration: { coordinateMode: capture.coordinateMode, source: 'user-confirmed' } });
  if (!result.snapshot) fail('E_PROJECT_IMPORT');
  return { project, bytes, metadata, verification, result };
}

// A project file uses its own storage. Existing browser workspaces are untouched.
export function projectStorage(project) {
  validateWorkspace(project.review); validateFieldWorkspace(project.field);
  const data = new Map([
    ['fresco-jw-review-v1', JSON.stringify(project.review)],
    ['fresco-jw-field-v1', JSON.stringify(project.field)],
  ]);
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
  };
}
