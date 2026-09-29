// Matrix [a,b,c,d,tx,ty]: x'=a*x+c*y+tx; y'=b*x+d*y+ty.
export const identity = [1, 0, 0, 1, 0, 0];
export function compose(a, b) {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3],
    a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
export function transformPoint(m, p) { return [m[0]*p[0]+m[2]*p[1]+m[4], m[1]*p[0]+m[3]*p[1]+m[5]]; }
export function blockMatrix(p) {
  if (![p.m_radKaitenKaku, p.m_dBairitsuX, p.m_dBairitsuY, p.m_DPKijunTen_x, p.m_DPKijunTen_y].every(Number.isFinite)) return Array(6).fill(NaN);
  const c = Math.cos(p.m_radKaitenKaku), s = Math.sin(p.m_radKaitenKaku);
  return [c*p.m_dBairitsuX, s*p.m_dBairitsuX, -s*p.m_dBairitsuY, c*p.m_dBairitsuY, p.m_DPKijunTen_x, p.m_DPKijunTen_y];
}
export const layerId = p => `${p.m_nGLayer.toString(16).toUpperCase()}:${p.m_nLayer.toString(16).toUpperCase()}`;
function localEntity(e) {
  const p = e.props;
  const result = { id: e.id, type: e.type, layerId: layerId(p), sourceProperties: p, editable: false };
  if (e.type === 'JwwSen') result.geometry = { kind: 'line', start: [p.m_start_x,p.m_start_y], end: [p.m_end_x,p.m_end_y] };
  if (e.type === 'JwwMoji') result.geometry = { kind: 'text', anchor: [p.m_start_x,p.m_start_y], text: p.m_string, font: p.m_strFontName, height: p.m_dSizeY, width: p.m_dSizeX, rotationDegrees: p.m_degKakudo };
  if (e.type === 'JwwTen') result.geometry = { kind: 'point', position: [p.m_start_x,p.m_start_y] };
  if (e.type === 'JwwEnko') result.geometry = { kind: 'ellipse-arc', center: [p.m_start_x,p.m_start_y], radius: p.m_dHankei, ratio: p.m_dHenpeiRitsu, tiltRadians: p.m_radKatamukiKaku, startRadians: p.m_radKaishiKaku, sweepRadians: p.m_radEnkoKaku, full: p.m_bZenEnFlg === 1 };
  if (e.type === 'JwwBlock') { result.definitionNumber = p.m_nNumber; result.localTransform = blockMatrix(p); }
  if (e.components) result.components = e.components.map(localEntity);
  return result;
}

export function buildStructure(document, { maxExpanded = 100000, maxDepth = 32 } = {}) {
  const diagnostics = [...(document.diagnostics ?? [])], definitions = (document.blocks ?? []).map(b => ({
    id: b.id, number: b.number, name: b.name, declaredCount: b.declaredCount, coordinateSpace: 'block-local-native', entities: b.entities.map(localEntity) }));
  const byNumber = new Map(), layers = new Map(document.layers.map(l => [l.id, l]));
  for (const definition of definitions) {
    if (byNumber.has(definition.number)) { byNumber.set(definition.number, null); diagnostics.push({ code: 'DUPLICATE_BLOCK_NUMBER', number: definition.number }); }
    else byNumber.set(definition.number, definition);
  }
  const entities = document.entities.map(localEntity), instances = [], expanded = [];
  let truncated = false;
  function visit(e, matrix, path, ancestors, effectiveLayerId) {
    if (truncated) return;
    if (expanded.length + instances.length >= maxExpanded) { truncated = true; diagnostics.push({ code: 'EXPANSION_LIMIT', path }); return; }
    if (!matrix.every(Number.isFinite)) { diagnostics.push({ code: 'INVALID_TRANSFORM', path }); return; }
    if (e.type === 'JwwBlock') {
      const definition = byNumber.get(e.definitionNumber), next = compose(matrix, e.localTransform);
      const instance = { path, sourceEntityId: e.id, definitionId: definition?.id ?? null,
        definitionNumber: e.definitionNumber, transformToModel: next, effectiveLayerId, status: 'resolved' };
      instances.push(instance);
      const code = !next.every(Number.isFinite) ? 'INVALID_TRANSFORM' : !definition ? 'MISSING_BLOCK_DEFINITION'
        : ancestors.includes(definition.id) ? 'BLOCK_CYCLE' : ancestors.length >= maxDepth ? 'BLOCK_DEPTH_LIMIT' : null;
      if (code) { instance.status = 'unresolved'; diagnostics.push({ code, path }); return; }
      for (const child of definition.entities) visit(child, next, `${path}/${child.id}`, [...ancestors, definition.id], effectiveLayerId);
      return;
    }
    const item = { path, sourceEntityId: e.id, sourceLayerId: e.layerId, effectiveLayerId, type: e.type,
      transformToModel: matrix, geometry: e.geometry ?? null, coordinateSpace: 'local-native-with-model-transform' };
    const coordinateFields = e.geometry?.kind === 'line' ? [...e.geometry.start, ...e.geometry.end]
      : e.geometry?.kind === 'text' ? e.geometry.anchor : e.geometry?.kind === 'point' ? e.geometry.position : null;
    if (coordinateFields && !coordinateFields.every(Number.isFinite)) diagnostics.push({ code: 'INVALID_GEOMETRY', path });
    else {
      if (e.geometry?.kind === 'line') item.modelPoints = [...transformPoint(matrix, e.geometry.start), ...transformPoint(matrix, e.geometry.end)];
      if (e.geometry?.kind === 'text') item.modelAnchor = transformPoint(matrix, e.geometry.anchor);
      if (e.geometry?.kind === 'point') item.modelPoint = transformPoint(matrix, e.geometry.position);
      for (const key of ['modelPoints', 'modelAnchor', 'modelPoint']) if (item[key] && !item[key].every(Number.isFinite)) {
        delete item[key]; diagnostics.push({ code: 'INVALID_GEOMETRY', path });
      }
    }
    // Keep ellipse geometry + affine matrix; nonuniform scaling/reflection is not a circle.
    expanded.push(item);
    if (e.components) for (const child of e.components) visit(child, matrix, `${path}/${child.id}`, ancestors, effectiveLayerId);
  }
  for (const e of entities) {
    const scale = layers.get(e.layerId)?.scale;
    if (!Number.isFinite(scale) || scale <= 0) { diagnostics.push({ code: 'INVALID_SCALE', entityId: e.id }); continue; }
    visit(e, [scale,0,0,scale,0,0], e.id, [], e.layerId);
  }
  return { entities, definitions, instances, expanded, diagnostics,
    coverage: { topLevel: entities.length, definitionEntities: definitions.reduce((n,b) => n+b.entities.length,0),
      expandedEntities: expanded.length, blockInstances: instances.length, truncated,
      unresolvedInstances: instances.filter(i => i.status !== 'resolved').length,
      limitations: ['Native wrapper may omit unrecognized classes.', 'Solid variants remain source properties.', 'Dimension auxiliary geometry unavailable.', 'Image metadata only; no OCR.', 'Block transforms require Jw_cad visual calibration.'] } };
}
