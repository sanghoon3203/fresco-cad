// Semantic cross-check of decodeJww output against native/jww.mjs readJww (JwwHelper DLL) output.
import { layersOf } from './jww-codec.mjs';
import { encodeCp932 } from './archive.mjs';

// The DLL wrapper exposes WORD m_sFlg as Int16; compare the 16-bit pattern.
const SIGNED16 = new Set(['m_sFlg']);
// The MBCS DLL turns Unicode-CString characters outside CP932 into '?'.
const lossy = text => [...text].map(ch => encodeCp932(ch) ? ch : '?').join('');
const close = (a, b) => a === b || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1, Math.abs(a)) * 1e-12);
function compareProps(ours, native, path, out, notes) {
  for (const [name, expected] of Object.entries(native)) {
    if (!(name in ours)) { out.push({ path: `${path}.${name}`, ours: undefined, native: expected }); continue; }
    const actual = ours[name];
    const same = expected === null ? !Number.isFinite(actual) : SIGNED16.has(name) ? (actual & 0xffff) === (expected & 0xffff)
      : typeof expected === 'number' ? close(actual, expected) : actual === expected;
    if (!same && typeof actual === 'string' && lossy(actual) === expected) notes.push({ code: 'NATIVE_LOSSY_STRING', path: `${path}.${name}`, ours: actual, native: expected });
    else if (!same) out.push({ path: `${path}.${name}`, ours: actual, native: expected });
  }
}
function compareEntities(ours, native, path, out, notes) {
  if (ours.length !== native.length) out.push({ path: `${path}.length`, ours: ours.length, native: native.length });
  for (let i = 0; i < Math.min(ours.length, native.length); i++) {
    const a = ours[i], b = native[i], where = `${path}[${i}]`;
    if (a.type !== b.type) { out.push({ path: `${where}.type`, ours: a.type, native: b.type }); continue; }
    compareProps(a.props, b.props, where, out, notes);
    // Native dimensions expose only the core line/text components.
    if (b.components) for (const c of b.components) {
      const part = c.id.endsWith('/line') ? 'm_Sen' : 'm_Moji';
      compareProps(a.props[part] ?? {}, c.props, `${where}.${part}`, out, notes);
    }
  }
}

/** Returns { ok, mismatches/notes (first `limit`), mismatchCount, noteCount, counts }. Version is excluded: the DLL reports its own write version. */
export function compareWithNative(doc, native, { limit = 20 } = {}) {
  const out = [], notes = [], ours = layersOf(doc);
  for (const layer of native.layers) {
    const mine = ours.find(l => l.id === layer.id);
    for (const key of ['name', 'groupName', 'state']) if (mine?.[key] !== layer[key] && !(typeof mine?.[key] === 'string' && lossy(mine[key]) === layer[key])) out.push({ path: `layers.${layer.id}.${key}`, ours: mine?.[key], native: layer[key] });
    if (!close(mine?.scale, layer.scale)) out.push({ path: `layers.${layer.id}.scale`, ours: mine?.scale, native: layer.scale });
  }
  compareEntities(doc.entities, native.entities, 'entities', out, notes);
  const blocks = native.blocks ?? [];
  if (doc.blocks.length !== blocks.length) out.push({ path: 'blocks.length', ours: doc.blocks.length, native: blocks.length });
  for (let i = 0; i < Math.min(doc.blocks.length, blocks.length); i++) {
    const a = doc.blocks[i], b = blocks[i];
    if (a.props.m_nNumber !== b.number || a.props.m_strName !== b.name) out.push({ path: `blocks[${i}]`, ours: [a.props.m_nNumber, a.props.m_strName], native: [b.number, b.name] });
    compareEntities(a.children, b.entities, `blocks[${i}].children`, out, notes);
  }
  if ((doc.images?.length ?? 0) !== (native.images ?? 0)) out.push({ path: 'images', ours: doc.images?.length ?? 0, native: native.images });
  return { ok: out.length === 0, mismatchCount: out.length, mismatches: out.slice(0, limit), notes: notes.slice(0, limit), noteCount: notes.length,
    counts: { entities: doc.entities.length, nativeEntities: native.entities.length, blocks: doc.blocks.length, nativeBlocks: blocks.length } };
}
