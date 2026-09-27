import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceStore, emptyWorkspace, recordReview, reviseProfile } from '../review/store.mjs';
import { createFieldStore, emptyFieldWorkspace, saveFinishCard, blankFinishCard } from '../field/standards.mjs';

const now = '2026-09-26T00:00:00.000Z';
const contextKey = 'a'.repeat(64);
const review = () => recordReview(reviseProfile(emptyWorkspace(), { shortLineMm: 1, gapMm: 5, allowedLayers: ['0:0'] }),
  { contextKey, issueId: 'line/1', status: 'excluded', note: '意図した目地' }, now);
const field = () => saveFinishCard(emptyFieldWorkspace(), contextKey, { ...blankFinishCard(), location: '1階 洋室' }, now, 'room-1');
function memory() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
for (const [name, create, initial, incoming, prefix] of [
  ['review', createWorkspaceStore, emptyWorkspace, review, 'E_REVIEW'],
  ['field', createFieldStore, emptyFieldWorkspace, field, 'E_FIELD'],
]) {
  const key = `fresco-jw-${name}-v1`;
  test(`${name}: restore is previewed, store-bound and one-use; retains the previous good version`, () => {
    const storage = memory(), store = create(storage);
    const current = store.save(initial()); const raw = store.exportRaw();
    const candidate = incoming(); candidate.revision = 998;
    const preview = store.prepareRestore(JSON.stringify(candidate));
    assert.equal(preview.mode, 'replace');
    assert.equal(preview.incoming.revision, current.revision + 1);
    assert.equal(store.exportRaw(), raw);
    assert.throws(() => create(storage).applyRestore(preview), { code: `${prefix}_PREVIEW` });
    // Both the displayed and applied data must remain identical to the reviewed preview.
    assert.throws(() => { preview.incoming.revision = 999; }, TypeError);
    assert.throws(() => { preview.mode = 'recover'; }, TypeError);
    const restored = store.applyRestore(preview);
    assert.equal(restored.revision, 2);
    assert.deepEqual(restored, { ...candidate, revision: 2 });
    assert.equal(storage.data.get(`${key}.backup`), raw);
    assert.throws(() => store.applyRestore(preview), { code: `${prefix}_PREVIEW` });
  });
  test(`${name}: same-revision changes and creation after an empty preview invalidate restore`, () => {
    const storage = memory(), store = create(storage);
    const emptyPreview = store.prepareRestore(JSON.stringify(incoming()));
    assert.equal(emptyPreview.mode, 'empty'); store.save(initial());
    assert.throws(() => store.applyRestore(emptyPreview), { code: `${prefix}_CONFLICT` });
    const preview = store.prepareRestore(JSON.stringify(initial()));
    const changed = JSON.stringify({ ...incoming(), revision: 1 }); storage.data.set(key, changed);
    assert.throws(() => store.applyRestore(preview), { code: `${prefix}_CONFLICT` });
    assert.equal(store.exportRaw(), changed);
    assert.equal(store.exportQuarantine(), null);
  });
  test(`${name}: corrupt and future originals are preserved exactly; good backup is retained`, () => {
    const storage = memory(), store = create(storage);
    const good = store.save(incoming()); store.save(good);
    const backup = storage.data.get(`${key}.backup`);
    for (const raw of ['{破損\r\n\u0000', '{"schemaVersion":999,"future":"unknown data"}']) {
      storage.data.set(key, raw);
      const preview = store.prepareRestore(JSON.stringify(incoming()));
      assert.equal(preview.mode, 'recover'); assert.equal(preview.current, null);
      assert.equal(store.exportRaw(), raw);
      const restored = store.applyRestore(preview);
      assert.equal(restored.revision, 1);
      assert.equal(storage.data.get(`${key}.backup`), backup);
      assert.ok(JSON.parse(store.exportQuarantine()).some(entry => entry.raw === raw));
    }
    assert.equal(JSON.parse(store.exportQuarantine()).length, 2);
  });
  test(`${name}: archive or primary write failure never reports recovery; retry preserves originals`, () => {
    for (const failedKey of [`${key}.quarantine`, key]) {
      const storage = memory(), store = create(storage);
      storage.data.set(key, '{broken');
      storage.data.set(`${key}.backup`, JSON.stringify(incoming()));
      const backup = storage.data.get(`${key}.backup`);
      const set = storage.setItem;
      storage.setItem = (k, value) => { if (k === failedKey) throw new Error('quota'); set(k, value); };
      assert.throws(() => store.applyRestore(store.prepareRestore(JSON.stringify(incoming()))), { code: `${prefix}_STORAGE` });
      assert.equal(store.exportRaw(), '{broken'); assert.equal(storage.data.get(`${key}.backup`), backup);
      storage.setItem = set;
      store.applyRestore(store.prepareRestore(JSON.stringify(incoming())));
      assert.equal(JSON.parse(store.exportQuarantine()).length, 1);
    }
  });
  test(`${name}: archive corruption, count/size limits and a late competing write fail closed`, () => {
    const storage = memory(), store = create(storage);
    for (const archived of ['bad archive', JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ raw: String(i), savedAt: now })))]) {
      storage.data.set(key, '{broken'); storage.data.set(`${key}.quarantine`, archived);
      assert.throws(() => store.applyRestore(store.prepareRestore(JSON.stringify(incoming()))), { code: `${prefix}_ARCHIVE` });
      assert.equal(store.exportRaw(), '{broken'); assert.equal(store.exportQuarantine(), archived);
    }
    storage.data.delete(`${key}.quarantine`); storage.data.set(key, 'x'.repeat(8 * 1024 * 1024));
    assert.throws(() => store.applyRestore(store.prepareRestore(JSON.stringify(incoming()))), { code: `${prefix}_ARCHIVE` });
    assert.equal(store.exportRaw().length, 8 * 1024 * 1024);
    storage.data.set(key, '{broken');
    const set = storage.setItem;
    storage.setItem = (k, value) => { set(k, value); if (k.endsWith('.quarantine')) storage.data.set(key, 'competing writer'); };
    assert.throws(() => store.applyRestore(store.prepareRestore(JSON.stringify(incoming()))), { code: `${prefix}_CONFLICT` });
    assert.equal(store.exportRaw(), 'competing writer');
    assert.equal(JSON.parse(store.exportQuarantine())[0].raw, '{broken');
  });
  test(`${name}: invalid backups and exhausted revisions cannot write any storage`, () => {
    const storage = memory(), store = create(storage);
    const invalid = ['{bad', JSON.stringify({ ...incoming(), schemaVersion: 999 }), ' '.repeat(2 * 1024 * 1024 + 1), JSON.stringify(name === 'field' ? review() : field())];
    for (const raw of invalid) assert.throws(() => store.prepareRestore(raw), { code: `${prefix}_CORRUPT` });
    assert.equal(storage.data.size, 0);
    storage.data.set(key, JSON.stringify({ ...initial(), revision: 2147483646 }));
    assert.throws(() => store.prepareRestore(JSON.stringify(incoming())));
    assert.equal(storage.data.size, 1);
  });
}

test('field recovery accepts validated legacy cards and refuses malformed legacy data', () => {
  const storage = memory(), store = createFieldStore(storage);
  storage.data.set('fresco-jw-field-v1', '{broken');
  const legacy = { schemaVersion: 1, revision: 7, layerMap: [], cards: [{ contextKey, card: blankFinishCard(), updatedAt: now }] };
  const preview = store.prepareRestore(JSON.stringify(legacy));
  assert.equal(preview.incoming.cards[0].id, 'legacy');
  assert.equal(store.applyRestore(preview).schemaVersion, 2);
  assert.throws(() => store.prepareRestore(JSON.stringify({ ...legacy, cards: [...legacy.cards, ...legacy.cards] })), { code: 'E_FIELD_CORRUPT' });
});
