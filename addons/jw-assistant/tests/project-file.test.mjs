import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseProject, serializeProject, projectStorage, encodeBytes, hashBytes, MAX_PROJECT_BYTES } from '../project/file.mjs';
import { createWorkspaceStore, createContextKey, recordReview } from '../review/store.mjs';
import { createFieldStore, blankFinishCard, fieldContextKey, saveFinishCard } from '../field/standards.mjs';
import { checkSnapshot } from '../core/engine.mjs';

const raw = await readFile(new URL('../fixtures/sample.jwproject.json', import.meta.url), 'utf8');
const fixture = () => JSON.parse(raw);
const context = result => createContextKey({ sourceHash: result.source.sha256, encoding: result.source.encoding,
  coordinateMode: result.source.coordinateMode, groupId: result.coverage.selectedGroup, profile: result.profile });

test('portable project round trip preserves saved decisions, notes and original bytes', async () => {
  const loaded = await parseProject(raw), p = loaded.project, key = await context(loaded.result);
  const issue = checkSnapshot(loaded.result.snapshot, loaded.result.profile)[0];
  p.review = recordReview(p.review, { contextKey: key, issueId: issue.id, status: 'recheck', note: '現場で確認' });
  p.field = saveFinishCard(p.field, await fieldContextKey(key, p.field.layerMap), { ...blankFinishCard(), location: '1階・A室' }, undefined, 'room-a');
  const reopened = await parseProject(serializeProject(p));
  assert.deepEqual(reopened.bytes, loaded.bytes);
  assert.equal(await context(reopened.result), key);
  assert.equal(reopened.project.review.reviews[0].note, '現場で確認');
  assert.equal(reopened.project.field.cards[0].card.location, '1階・A室');
  assert.deepEqual(checkSnapshot(reopened.result.snapshot, reopened.result.profile)[0], issue);
});

test('project stores are isolated and saving cannot mutate the imported file object', async () => {
  const p = fixture(), first = projectStorage(p), second = projectStorage(p);
  const store = createWorkspaceStore(first, 'fresco-jw-review-v1');
  store.save(recordReview(store.load(), { contextKey: 'a'.repeat(64), issueId: 'test', status: 'reviewing', note: 'first only' }));
  assert.equal(p.review.reviews.length, 0);
  assert.equal(createWorkspaceStore(second, 'fresco-jw-review-v1').load().reviews.length, 0);
  assert.equal(createFieldStore(first).load().cards.length, 0);
  assert.equal(store.load().reviews.length, 1);
});

test('rejects corrupt/future/oversized project files and unknown schema fields', async () => {
  await assert.rejects(parseProject('{'), { code: 'E_PROJECT_JSON' });
  await assert.rejects(parseProject(' '.repeat(MAX_PROJECT_BYTES + 1)), { code: 'E_PROJECT_LIMIT' });
  for (const mutate of [p => p.schemaVersion = 2, p => p.extra = true, p => p.capture.extra = true]) {
    const p = fixture(); mutate(p); await assert.rejects(parseProject(JSON.stringify(p)), { code: 'E_PROJECT_SCHEMA' });
  }
  for (const mutate of [p => p.capture.group = '10', p => p.capture.coordinateMode = 'unknown', p => p.capture.encoding = 'auto']) {
    const p = fixture(); mutate(p); await assert.rejects(parseProject(JSON.stringify(p)), { code: 'E_PROJECT_OPTIONS' });
  }
  const p = fixture(); p.field.schemaVersion = 3; await assert.rejects(parseProject(JSON.stringify(p)), { code: 'E_FIELD_SCHEMA' });
});

test('tampered bytes/hash and malformed base64 fail before installation', async () => {
  const p = fixture(); p.capture.sha256 = '0'.repeat(64);
  await assert.rejects(parseProject(JSON.stringify(p)), { code: 'E_PROJECT_HASH' });
  for (const base64 of ['***=', 'YQ', 'YR==', '====', '']) {
    p.capture.base64 = base64; await assert.rejects(parseProject(JSON.stringify(p)), { code: 'E_PROJECT_BYTES' });
  }
});

test('preserves Shift_JIS bytes without text transcoding', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../fixtures/jwc-temp/jw-10.3.6-line-10000-shift-jis.txt', import.meta.url)));
  const p = fixture(); p.capture.base64 = encodeBytes(bytes); p.capture.sha256 = await hashBytes(bytes); p.capture.encoding = 'shift_jis';
  const opened = await parseProject(JSON.stringify(p));
  assert.deepEqual(opened.bytes, bytes); assert.equal(opened.result.source.encoding, 'shift_jis');
});

test('metadata remains authoritative; mismatched metadata is rejected', async () => {
  const p = fixture(), opened = await parseProject(raw), sha256 = p.capture.sha256, length = opened.bytes.length;
  const metadata = { schemaVersion: 1, captureKind: 'jwc-temp-diagnostic', capturedAtUtc: '2026-09-28T00:00:00Z', publication: { status: 'complete' },
    source: { length, sha256, codec: 'ascii-compatible', hqFirstLinePreserved: true }, capture: { length, sha256, byteIdentical: true } };
  p.capture.metadataBase64 = encodeBytes(new TextEncoder().encode(JSON.stringify(metadata)));
  assert.equal((await parseProject(JSON.stringify(p))).verification.integrity, 'matched');
  metadata.capture.sha256 = 'a'.repeat(64); p.capture.metadataBase64 = encodeBytes(new TextEncoder().encode(JSON.stringify(metadata)));
  await assert.rejects(parseProject(JSON.stringify(p)), { code: 'E_BUNDLE_INTEGRITY' });
});

test('different units and group never silently reassign prior review contexts', async () => {
  const first = await parseProject(raw), key = await context(first.result), p = fixture();
  p.review = recordReview(p.review, { contextKey: key, issueId: 'test', status: 'reviewing', note: 'original' });
  p.capture.group = '1'; p.capture.coordinateMode = 'paper-mm';
  const next = await parseProject(JSON.stringify(p));
  assert.notEqual(await context(next.result), key); assert.equal(next.project.review.reviews[0].contextKey, key);
});
