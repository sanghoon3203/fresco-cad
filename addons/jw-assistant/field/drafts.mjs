// Session-only drafts. Keys always include the checked context and card identity.
export function createDrafts() {
  const items = new Map();
  const keyFor = (contextKey, id) => JSON.stringify([contextKey, id]);
  return {
    set(contextKey, id, card) { items.set(keyFor(contextKey,id), {contextKey,id,card:structuredClone(card)}); },
    get(contextKey,id) { const item = items.get(keyFor(contextKey,id)); return item ? structuredClone(item.card) : null; },
    clear(contextKey,id) { items.delete(keyFor(contextKey,id)); },
    forContext(contextKey) { return [...items.values()].filter(item => item.contextKey === contextKey).map(item => structuredClone(item)); },
    all() { return [...items.values()].map(item => structuredClone(item)); },
    get size() { return items.size; },
  };
}
