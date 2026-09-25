import test from 'node:test';
import assert from 'node:assert/strict';
import { blankFinishCard, createFieldStore, emptyFieldWorkspace, parseFieldBackup, restoreFieldBackup, saveFinishCard, validateFieldWorkspace } from '../field/standards.mjs';

const key = 'a'.repeat(64), other = 'b'.repeat(64), storageKey = 'fresco-jw-field-v1';
const timestamp = '2026-01-01T00:00:00.000Z';
const legacy = () => ({ schemaVersion: 1, revision: 7, layerMap: [], cards: [{ contextKey: key, card: blankFinishCard(), updatedAt: timestamp }] });
function memoryStorage() {
  const data = new Map();
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
}

test('strict v1 load migrates in memory and retains revision until save', () => {
  const storage = memoryStorage(), raw = JSON.stringify(legacy());
  storage.data.set(storageKey, raw);
  const store = createFieldStore(storage), loaded = store.load();
  assert.equal(loaded.schemaVersion, 2);
  assert.equal(loaded.revision, 7);
  assert.equal(loaded.cards[0].id, 'legacy');
  assert.equal(storage.data.get(storageKey), raw);
  assert.throws(() => validateFieldWorkspace(legacy()), { code: 'E_FIELD_SCHEMA' });
  const saved = store.save(loaded);
  assert.equal(saved.revision, 8);
  assert.equal(store.loadBackup().cards[0].id, 'legacy');
  assert.equal(JSON.parse(storage.data.get(storageKey)).schemaVersion, 2);
});

test('invalid legacy records cannot migrate', () => {
  const malformed = legacy(); malformed.cards.push({ ...malformed.cards[0] });
  assert.throws(() => parseFieldBackup(JSON.stringify(malformed)), { code: 'E_FIELD_CORRUPT' });
  const extra = legacy(); extra.cards[0].unexpected = true;
  assert.throws(() => parseFieldBackup(JSON.stringify(extra)), { code: 'E_FIELD_CORRUPT' });
});

test('cards are isolated by context and id and duplicates are rejected', () => {
  const original = emptyFieldWorkspace();
  const first = saveFinishCard(original, key, blankFinishCard(), timestamp, 'card_1');
  const second = saveFinishCard(first, key, blankFinishCard('floor-finish'), timestamp, 'card-2');
  const third = saveFinishCard(second, other, blankFinishCard(), timestamp, 'card_1');
  assert.equal(original.cards.length, 0);
  assert.equal(third.cards.length, 3);
  assert.equal(saveFinishCard(third, key, blankFinishCard(), timestamp, 'card-2').cards.length, 3);
  assert.equal(third.cards.find(r => r.id === 'card-2').card.categoryId, 'floor-finish');
  assert.throws(() => validateFieldWorkspace({ ...third, cards: [...third.cards, third.cards[0]] }), { code: 'E_FIELD_CONTEXT' });
  assert.throws(() => saveFinishCard(third, key, blankFinishCard(), timestamp, 'bad id'), { code: 'E_FIELD_ID' });
  let full = emptyFieldWorkspace();
  for (let i = 0; i < 100; i++) full = saveFinishCard(full, key, blankFinishCard(), timestamp, String(i));
  assert.throws(() => saveFinishCard(full, key, blankFinishCard(), timestamp, 'overflow'), { code: 'E_FIELD_LIMIT' });
});

test('backup parse is bounded; restore uses current revision and leaves input isolated', () => {
  const incoming = parseFieldBackup(JSON.stringify(legacy()));
  const current = { ...emptyFieldWorkspace(), revision: 12 };
  const restored = restoreFieldBackup(current, incoming);
  assert.equal(restored.revision, 12);
  assert.equal(restored.cards[0].id, 'legacy');
  restored.cards[0].card.location = 'changed';
  assert.equal(incoming.cards[0].card.location, '');
  assert.throws(() => parseFieldBackup(' '.repeat(2 * 1024 * 1024 + 1)), { code: 'E_FIELD_CORRUPT' });
  assert.throws(() => parseFieldBackup(JSON.stringify({ ...incoming, extra: true })), { code: 'E_FIELD_CORRUPT' });
});

test('restore save rejects stale and corrupt primary and preserves previous good backup', () => {
  const storage = memoryStorage(), store = createFieldStore(storage);
  const first = store.save(saveFinishCard(store.load(), key, blankFinishCard(), timestamp));
  const imported = saveFinishCard(emptyFieldWorkspace(), other, blankFinishCard(), timestamp, 'imported');
  const replacement = restoreFieldBackup(first, imported);
  const latest = store.save(replacement);
  assert.equal(latest.revision, 2);
  assert.equal(store.loadBackup().cards[0].contextKey, key);
  assert.throws(() => store.save(replacement), { code: 'E_FIELD_CONFLICT' });
  const goodBackup = storage.data.get(`${storageKey}.backup`);
  storage.data.set(storageKey, '{bad');
  assert.throws(() => store.save(restoreFieldBackup(latest, imported)), { code: 'E_FIELD_CORRUPT' });
  assert.equal(storage.data.get(`${storageKey}.backup`), goodBackup);
  assert.equal(storage.data.get(storageKey), '{bad');
});

test('quota failure on backup leaves primary intact', () => {
  const storage = memoryStorage(), store = createFieldStore(storage);
  const first = store.save(store.load());
  const prior = storage.data.get(storageKey);
  storage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => store.save(first), { code: 'E_FIELD_STORAGE' });
  assert.equal(storage.data.get(storageKey), prior);
});
