import { validateProfile } from '../core/engine.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REVISION = 2_147_483_646;
const HASH = /^[a-f0-9]{64}$/u;
const STATES = new Set(['reviewing', 'excluded', 'recheck']);
const copy = value => structuredClone(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('E_REVIEW_SCHEMA');
  const actual = Object.keys(value).sort();
  if (actual.join('|') !== [...keys].sort().join('|')) fail('E_REVIEW_SCHEMA');
}
function text(value, limit, blank = false) {
  if (typeof value !== 'string' || value.length > limit || (!blank && !value.trim())
    || !value.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail('E_REVIEW_TEXT');
}
function profile(value) {
  try { validateProfile(value); } catch { fail('E_REVIEW_PROFILE'); }
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_REVISION) fail('E_REVIEW_REVISION');
}
function serialized(value) {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > MAX_BYTES) fail('E_REVIEW_LIMIT');
  return json;
}
function validateRecord(record) {
  exact(record, ['contextKey', 'issueId', 'status', 'note', 'updatedAt']);
  if (typeof record.contextKey !== 'string' || !HASH.test(record.contextKey)) fail('E_REVIEW_CONTEXT');
  text(record.issueId, 1024);
  text(record.note, 2000, true);
  if (!STATES.has(record.status)) fail('E_REVIEW_STATUS');
  if (record.status === 'excluded' && !record.note.trim()) fail('E_REVIEW_REASON');
  if (typeof record.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(record.updatedAt)
    || !Number.isFinite(Date.parse(record.updatedAt)) || new Date(record.updatedAt).toISOString() !== record.updatedAt) fail('E_REVIEW_TIME');
}

export function emptyWorkspace() { return { schemaVersion: 1, revision: 0, profile: null, reviews: [] }; }

export function validateWorkspace(workspace) {
  exact(workspace, ['schemaVersion', 'revision', 'profile', 'reviews']);
  if (workspace.schemaVersion !== 1) fail('E_REVIEW_SCHEMA');
  revision(workspace.revision);
  if (workspace.profile !== null) {
    profile(workspace.profile);
    if (workspace.profile.id !== 'office-local') fail('E_REVIEW_PROFILE');
  }
  if (!Array.isArray(workspace.reviews) || workspace.reviews.length > 500) fail('E_REVIEW_LIMIT');
  const seen = new Set();
  for (const record of workspace.reviews) {
    validateRecord(record);
    const key = JSON.stringify([record.contextKey, record.issueId]);
    if (seen.has(key)) fail('E_REVIEW_DUPLICATE');
    seen.add(key);
  }
  serialized(workspace);
  return workspace;
}

export function reviseProfile(workspace, fields) {
  validateWorkspace(workspace);
  exact(fields, ['shortLineMm', 'gapMm', 'allowedLayers']);
  const next = copy(workspace);
  next.profile = { id: 'office-local', version: (workspace.profile?.version ?? 0) + 1, ...copy(fields) };
  return validateWorkspace(next);
}

export async function createContextKey(context) {
  exact(context, ['sourceHash', 'encoding', 'coordinateMode', 'groupId', 'profile']);
  if (typeof context.sourceHash !== 'string' || !HASH.test(context.sourceHash)
    || !['utf-8', 'shift_jis'].includes(context.encoding)
    || !['model-mm', 'paper-mm'].includes(context.coordinateMode)
    || typeof context.groupId !== 'string' || !/^[0-9a-f]$/iu.test(context.groupId)) fail('E_REVIEW_CONTEXT');
  profile(context.profile);
  const p = context.profile;
  const canonical = JSON.stringify({ checkerVersion: 'line-checker-v1', sourceHash: context.sourceHash,
    encoding: context.encoding, coordinateMode: context.coordinateMode, groupId: context.groupId.toUpperCase(),
    profile: { id: p.id, version: p.version, shortLineMm: p.shortLineMm, gapMm: p.gapMm, allowedLayers: [...p.allowedLayers].sort() } });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function recordReview(workspace, fields, now = new Date().toISOString()) {
  validateWorkspace(workspace);
  exact(fields, ['contextKey', 'issueId', 'status', 'note']);
  const record = { ...copy(fields), updatedAt: now };
  validateRecord(record);
  const next = copy(workspace);
  const index = next.reviews.findIndex(item => item.contextKey === record.contextKey && item.issueId === record.issueId);
  if (index < 0) next.reviews.push(record); else next.reviews[index] = record;
  return validateWorkspace(next);
}

export function reviewsForContext(workspace, contextKey) {
  validateWorkspace(workspace);
  if (typeof contextKey !== 'string' || !HASH.test(contextKey)) fail('E_REVIEW_CONTEXT');
  return copy(workspace.reviews.filter(record => record.contextKey === contextKey));
}

function parse(raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_BYTES) fail('E_REVIEW_CORRUPT');
  try { return validateWorkspace(JSON.parse(raw)); } catch { fail('E_REVIEW_CORRUPT'); }
}

export function createWorkspaceStore(storage, key = 'fresco-jw-review-v1') {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') fail('E_REVIEW_STORAGE');
  text(key, 128);
  const get = name => { try { return storage.getItem(name); } catch { fail('E_REVIEW_STORAGE'); } };
  const set = (name, value) => { try { storage.setItem(name, value); } catch { fail('E_REVIEW_STORAGE'); } };
  return {
    load() { const raw = get(key); return raw === null ? emptyWorkspace() : parse(raw); },
    loadBackup() { const raw = get(`${key}.backup`); return raw === null ? null : parse(raw); },
    save(workspace) {
      validateWorkspace(workspace);
      const raw = get(key);
      const current = raw === null ? emptyWorkspace() : parse(raw);
      if (current.revision !== workspace.revision) fail('E_REVIEW_CONFLICT');
      const next = copy(workspace);
      next.revision += 1;
      validateWorkspace(next);
      const encoded = serialized(next);
      // Best-effort stale writer detection, NOT an atomic transaction between tabs.
      // A failed backup must stop before replacing the primary record.
      if (raw !== null) set(`${key}.backup`, raw);
      set(key, encoded);
      return next;
    },
  };
}
