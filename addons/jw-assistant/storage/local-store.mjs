/** Bounded local JSON with previous-good backup; sequential single-tab use. */
export function createJsonStore(storage, key, { initial, validate, prefix, maxBytes = 2 * 1024 * 1024 }) {
  const fail = suffix => { throw Object.assign(new Error(`${prefix}_${suffix}`), { code: `${prefix}_${suffix}` }); };
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') fail('STORAGE');
  const get = name => { try { return storage.getItem(name); } catch { fail('STORAGE'); } };
  const set = (name, value) => { try { storage.setItem(name, value); } catch { fail('STORAGE'); } };
  const parse = raw => {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > maxBytes) fail('CORRUPT');
    try { return validate(JSON.parse(raw)); } catch { fail('CORRUPT'); }
  };
  return {
    load() { const raw = get(key); return raw === null ? initial() : parse(raw); },
    loadBackup() { const raw = get(`${key}.backup`); return raw === null ? null : parse(raw); },
    save(value) {
      validate(value);
      const raw = get(key);
      const current = raw === null ? initial() : parse(raw);
      if (current.revision !== value.revision) fail('CONFLICT');
      const next = structuredClone(value); next.revision += 1; validate(next);
      const encoded = JSON.stringify(next);
      if (new TextEncoder().encode(encoded).length > maxBytes) fail('LIMIT');
      // This revision check is not an atomic multi-tab transaction.
      if (raw !== null) set(`${key}.backup`, raw);
      set(key, encoded);
      return next;
    },
  };
}
