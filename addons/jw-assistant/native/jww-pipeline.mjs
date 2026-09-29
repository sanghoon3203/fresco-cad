import { hash, fail, readJww, patchLine, verifyLineEdit } from './jww.mjs';

const fields = ['m_start_x', 'm_start_y', 'm_end_x', 'm_end_y'];
const layerId = p => `${p.m_nGLayer.toString(16).toUpperCase()}:${p.m_nLayer.toString(16).toUpperCase()}`;

// The native record stays local. AI-facing coordinates use model millimetres.
export function toIR(bytes, document) {
  return {
    schemaVersion: 1, sourceHash: hash(bytes), formatVersion: document.version,
    units: 'model-mm', axes: 'drawing-xy',
    layers: document.layers,
    entities: document.entities.map(entity => {
      const p = entity.props, layer = document.layers.find(item => item.id === layerId(p));
      let editable = false;
      if (entity.type === 'JwwSen' && Number.isFinite(layer?.scale) && layer.scale > 0) {
        try { patchLine(bytes, document, entity.id, fields.map(name => p[name])); editable = true; } catch {}
      }
      return { id: entity.id, type: entity.type, layerId: layerId(p), editable,
        ...(entity.type === 'JwwSen' && Number.isFinite(layer?.scale) && layer.scale > 0
          ? { points: fields.map(name => p[name] * layer.scale) } : {}) };
    }),
    coverage: { scope: 'top-level', blockDefinitions: document.blockDefinitions, images: document.images }
  };
}

export function translate(bytes, document, patch) {
  if (!patch || Object.keys(patch).sort().join(',') !== 'dx,dy,ids,op,schemaVersion,sourceHash,units'
      || patch.schemaVersion !== 1 || patch.op !== 'TranslateEntities' || patch.units !== 'model-mm'
      || !Array.isArray(patch.ids) || patch.ids.length < 1 || patch.ids.length > 100
      || patch.ids.some(id => typeof id !== 'string') || new Set(patch.ids).size !== patch.ids.length
      || ![patch.dx, patch.dy].every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e7)) fail('E_PATCH_SCHEMA');
  if (patch.sourceHash !== hash(bytes)) fail('E_PATCH_STALE');
  const changes = patch.ids.map(id => {
    const entity = document.entities.find(item => item.id === id);
    if (!entity || entity.type !== 'JwwSen') fail('E_PATCH_ENTITY');
    const layer = document.layers.find(item => item.id === layerId(entity.props));
    if (!Number.isFinite(layer?.scale) || layer.scale <= 0) fail('E_PATCH_SCALE');
    const points = fields.map((name, i) => entity.props[name] + (i % 2 ? patch.dy : patch.dx) / layer.scale);
    const result = patchLine(bytes, document, id, points);
    return { id, points, offset: result.coordinateOffset, bytes: result.bytes };
  });
  // Locate every record in the original; edits that become duplicates remain valid.
  const ordered = [...changes].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ordered.length; i++) if (ordered[i].offset < ordered[i - 1].offset + 32) fail('E_PATCH_OVERLAP');
  const output = Buffer.from(bytes), expected = structuredClone(document);
  for (const change of changes) {
    change.bytes.copy(output, change.offset, change.offset, change.offset + 32);
    const entity = expected.entities.find(item => item.id === change.id);
    const record = Buffer.from(entity.record, 'base64');
    fields.forEach((name, i) => { entity.props[name] = change.points[i]; record.writeDoubleLE(change.points[i], 15 + i * 8); });
    entity.record = record.toString('base64');
  }
  return { bytes: output, expected, changes: changes.map(({ id, points, offset }) => ({ id, points, offset })) };
}

export async function applyJwwPatch(bytes, patch) {
  const before = await readJww(bytes);
  const result = translate(bytes, before, patch);
  const after = await readJww(result.bytes);
  // A nonexistent target makes the verifier compare every entity unchanged
  // against our independently constructed expected document.
  verifyLineEdit(result.expected, after, null, []);
  return { bytes: result.bytes, ir: toIR(result.bytes, after),
    receipt: { sourceHash: hash(bytes), outputHash: hash(result.bytes), changes: result.changes,
      nativeReparse: true, jwcadVisualVerified: false } };
}
