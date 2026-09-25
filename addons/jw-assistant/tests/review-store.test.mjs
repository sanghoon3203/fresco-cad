import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyWorkspace, validateWorkspace, reviseProfile, createContextKey, recordReview, reviewsForContext, createWorkspaceStore } from '../review/store.mjs';

const fields = { shortLineMm: 0.5, gapMm: 5, allowedLayers: ['0:0', '0:1'] };
const context = { sourceHash: 'a'.repeat(64), encoding: 'shift_jis', coordinateMode: 'model-mm', groupId: '0', profile: reviseProfile(emptyWorkspace(), fields).profile };
const record = { contextKey: 'b'.repeat(64), issueId: 'near-gap/line-1/line-2', status: 'excluded', note: '意図した目地' };
const now = '2026-09-25T01:00:00.000Z';
function memory() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
const rejects = (fn, code) => assert.throws(fn, { code });

test('office profile uses engine validation, immutable versions and exact fields', () => {
  const original = emptyWorkspace();
  const first = reviseProfile(original, fields);
  const second = reviseProfile(first, { ...fields, gapMm: 10 });
  assert.equal(original.profile, null);
  assert.equal(first.profile.gapMm, 5);
  assert.equal(second.profile.version, 2);
  assert.equal(second.revision, 0);
  for (const invalid of [{ ...fields, gapMm: 0 }, { ...fields, shortLineMm: NaN }, { ...fields, allowedLayers: ['0:0', '0:0'] }, { ...fields, shortLineMm: '1' }]) rejects(() => reviseProfile(first, invalid), 'E_REVIEW_PROFILE');
  rejects(() => reviseProfile(first, { ...fields, writeAllowed: true }), 'E_REVIEW_SCHEMA');
});

test('context isolates bytes, codec, units, group and full rules; layer ordering is stable', async () => {
  const key = await createContextKey(context);
  assert.match(key, /^[a-f0-9]{64}$/u);
  assert.equal(await createContextKey({ ...context, profile: { ...context.profile, allowedLayers: [...fields.allowedLayers].reverse() } }), key);
  for (const change of [{ sourceHash: 'c'.repeat(64) }, { encoding: 'utf-8' }, { coordinateMode: 'paper-mm' }, { groupId: '1' }, { profile: { ...context.profile, gapMm: 6 } }, { profile: { ...context.profile, version: 2 } }]) assert.notEqual(await createContextKey({ ...context, ...change }), key);
  await assert.rejects(createContextKey({ ...context, groupId: null }), { code: 'E_REVIEW_CONTEXT' });
});

test('review decisions require reasons and remain isolated when rules or source change', () => {
  const original = emptyWorkspace();
  const first = recordReview(original, record, now);
  const updated = recordReview(first, { ...record, status: 'recheck', note: '再確認' }, now);
  assert.equal(original.reviews.length, 0);
  assert.equal(first.reviews[0].status, 'excluded');
  assert.equal(updated.reviews.length, 1);
  assert.equal(reviewsForContext(updated, 'a'.repeat(64)).length, 0);
  const selected = reviewsForContext(updated, record.contextKey);
  selected[0].note = 'changed';
  assert.equal(updated.reviews[0].note, '再確認');
  rejects(() => recordReview(first, { ...record, note: '  ' }, now), 'E_REVIEW_REASON');
  rejects(() => recordReview(first, { ...record, status: 'resolved' }, now), 'E_REVIEW_STATUS');
  rejects(() => recordReview(first, { ...record, note: 'x'.repeat(2001) }, now), 'E_REVIEW_TEXT');
  rejects(() => recordReview(first, record, '2026-02-30T01:00:00.000Z'), 'E_REVIEW_TIME');
  rejects(() => validateWorkspace({ ...first, reviews: [first.reviews[0], first.reviews[0]] }), 'E_REVIEW_DUPLICATE');
});

test('local store persists revisions, keeps previous good backup and refuses stale writers', () => {
  const storage = memory(); const store = createWorkspaceStore(storage);
  const blank = store.load();
  assert.equal(store.loadBackup(), null);
  const first = store.save(reviseProfile(blank, fields));
  assert.equal(first.revision, 1);
  const second = store.save(recordReview(first, record, now));
  assert.deepEqual(store.load(), second);
  assert.deepEqual(store.loadBackup(), first);
  rejects(() => store.save(first), 'E_REVIEW_CONFLICT');
  assert.deepEqual(store.load(), second);
});

test('corrupt or future workspace is preserved; backup remains separately readable', () => {
  const storage = memory(); const store = createWorkspaceStore(storage);
  const first = store.save(reviseProfile(store.load(), fields));
  store.save(recordReview(first, record, now));
  for (const bad of ['{bad', JSON.stringify({ ...emptyWorkspace(), schemaVersion: 2 }), JSON.stringify({ ...emptyWorkspace(), secret: 'unsupported' }), 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    storage.data.set('fresco-jw-review-v1', bad);
    rejects(() => store.load(), 'E_REVIEW_CORRUPT');
    rejects(() => store.save(first), 'E_REVIEW_CORRUPT');
    assert.equal(storage.data.get('fresco-jw-review-v1'), bad);
    assert.deepEqual(store.loadBackup(), first);
  }
});

test('quota and storage access failures never return a false saved revision or replace primary', () => {
  const storage = memory(); const store = createWorkspaceStore(storage);
  const first = store.save(reviseProfile(store.load(), fields));
  const next = recordReview(first, record, now);
  const raw = storage.data.get('fresco-jw-review-v1');
  for (const failedKey of ['fresco-jw-review-v1.backup', 'fresco-jw-review-v1']) {
    storage.setItem = (key, value) => { if (key === failedKey) throw new Error('quota'); storage.data.set(key, value); };
    rejects(() => store.save(next), 'E_REVIEW_STORAGE');
    assert.equal(storage.data.get('fresco-jw-review-v1'), raw);
    assert.equal(next.revision, 1);
  }
  storage.getItem = () => { throw new Error('disabled'); };
  rejects(() => store.load(), 'E_REVIEW_STORAGE');
});

test('workspace limits reject record overflow and multi-byte serialized size overflow', () => {
  const records = Array.from({ length: 501 }, (_, i) => ({ ...record, issueId: String(i), updatedAt: now }));
  rejects(() => validateWorkspace({ ...emptyWorkspace(), reviews: records }), 'E_REVIEW_LIMIT');
  rejects(() => validateWorkspace({ ...emptyWorkspace(), reviews: records.slice(0, 500).map(r => ({ ...r, note: '図'.repeat(2000) })) }), 'E_REVIEW_LIMIT');
});
