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
  const tickets = new WeakMap();
  const quarantineKey = `${key}.quarantine`;
  const maxArchiveBytes = 8 * 1024 * 1024;
  const archive = () => {
    const raw = get(quarantineKey);
    if (raw === null) return [];
    try {
      if (new TextEncoder().encode(raw).length > maxArchiveBytes) fail('ARCHIVE');
      const entries = JSON.parse(raw);
      if (!Array.isArray(entries) || entries.length > 5 || entries.some(entry =>
        !entry || Object.keys(entry).sort().join('|') !== 'raw|savedAt'
        || typeof entry.raw !== 'string' || typeof entry.savedAt !== 'string'
        || !Number.isFinite(Date.parse(entry.savedAt)))) fail('ARCHIVE');
      return entries;
    } catch { fail('ARCHIVE'); }
  };
  const encode = value => {
    validate(value);
    const raw = JSON.stringify(value);
    if (new TextEncoder().encode(raw).length > maxBytes) fail('LIMIT');
    return raw;
  };
  const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  return {
    load() { const raw = get(key); return raw === null ? initial() : parse(raw); },
    loadBackup() { const raw = get(`${key}.backup`); return raw === null ? null : parse(raw); },
    // Raw text remains exportable even when it cannot be parsed or migrated.
    exportRaw() { return get(key); },
    exportQuarantine() { return get(quarantineKey); },
    prepareRestore(raw) {
      const incoming = structuredClone(parse(raw));
      const expected = get(key);
      let current = null;
      if (expected !== null) { try { current = parse(expected); } catch { /* Preserve unsupported data too. */ } }
      const mode = expected === null ? 'empty' : current ? 'replace' : 'recover';
      incoming.revision = (current?.revision ?? 0) + 1;
      const encoded = encode(incoming);
      const preview = freeze({ mode, current: structuredClone(current), incoming: structuredClone(incoming) });
      // Bind the exact replacement and source to this store; caller edits cannot alter approval.
      tickets.set(preview, { expected, encoded, mode });
      return preview;
    },
    applyRestore(preview) {
      const ticket = preview && tickets.get(preview);
      if (!ticket) fail('PREVIEW');
      tickets.delete(preview);
      const { expected, encoded, mode } = ticket;
      if (get(key) !== expected) fail('CONFLICT');
      if (mode === 'recover') {
        const entries = archive();
        if (!entries.some(entry => entry.raw === expected)) {
          entries.push({ savedAt: new Date().toISOString(), raw: expected });
          const raw = JSON.stringify(entries);
          if (entries.length > 5 || new TextEncoder().encode(raw).length > maxArchiveBytes) fail('ARCHIVE');
          set(quarantineKey, raw);
          if (get(quarantineKey) !== raw) fail('STORAGE');
        }
        // Keep the previous good backup intact when the primary is corrupt.
      } else if (expected !== null) set(`${key}.backup`, expected);
      // Best effort only: localStorage does not offer cross-tab compare-and-swap.
      if (get(key) !== expected) fail('CONFLICT');
      set(key, encoded);
      if (get(key) !== encoded) fail('CONFLICT');
      return parse(encoded);
    },
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
