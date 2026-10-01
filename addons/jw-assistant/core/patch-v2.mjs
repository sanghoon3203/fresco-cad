// Patch v2: the only edit language AI providers may emit. See docs/jw-assistant/patch-v2.md.
// Pure module: no filesystem, network or native imports. Coordinates are model mm on drawing XY;
// text sizes are paper mm (Jw_cad convention). Angles are degrees, counter-clockwise.

const fail = (code, detail) => { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, detail }); };
export const PATCH_V2_LIMITS = Object.freeze({ ops: 200, ids: 500, text: 2000, coordinate: 1e8 });
const LAYER = /^[0-9A-F]:[0-9A-F]$/u, TEMP = /^n[0-9]{1,4}$/u;

const num = { type: 'number' }, nullableNum = { type: ['number', 'null'] };
const point = { type: 'array', items: num, minItems: 2, maxItems: 2 }, nullablePoint = { type: ['array', 'null'], items: num, minItems: 2, maxItems: 2 };
const ids = { type: 'array', items: { type: 'string' } };
const obj = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const pen = obj({ color: nullableNum, style: nullableNum, width: nullableNum });
const entitySchemas = [
  obj({ kind: { type: 'string', enum: ['line'] }, layer: { type: 'string' }, start: point, end: point, pen }),
  obj({ kind: { type: 'string', enum: ['text'] }, layer: { type: 'string' }, at: point, text: { type: 'string' }, height: nullableNum, width: nullableNum,
    spacing: nullableNum, angle: nullableNum, style: nullableNum, color: nullableNum }),
  obj({ kind: { type: 'string', enum: ['arc'] }, layer: { type: 'string' }, center: point, radius: num, startAngle: num, sweepAngle: num,
    flatness: nullableNum, tilt: nullableNum, pen }),
  obj({ kind: { type: 'string', enum: ['point'] }, layer: { type: 'string' }, at: point, pen })
];
const modifySet = obj({ start: nullablePoint, end: nullablePoint, at: nullablePoint, center: nullablePoint, radius: nullableNum,
  startAngle: nullableNum, sweepAngle: nullableNum, text: { type: ['string', 'null'] }, height: nullableNum, width: nullableNum, angle: nullableNum });
const opSchemas = [
  obj({ op: { type: 'string', enum: ['add'] }, tempId: { type: ['string', 'null'] }, entity: { anyOf: entitySchemas } }),
  obj({ op: { type: 'string', enum: ['delete'] }, ids }),
  obj({ op: { type: 'string', enum: ['translate'] }, ids, dx: num, dy: num }),
  obj({ op: { type: 'string', enum: ['modify'] }, id: { type: 'string' }, set: modifySet }),
  obj({ op: { type: 'string', enum: ['setLayer'] }, ids, layer: { type: 'string' } }),
  obj({ op: { type: 'string', enum: ['setPen'] }, ids, pen })
];
// Strict structured-output schema shared by OpenAI (json_schema strict) and Anthropic (tool input_schema).
export const patchV2JsonSchema = obj({
  schemaVersion: { type: 'integer', enum: [2] }, sourceHash: { type: 'string' }, units: { type: 'string', enum: ['model-mm'] },
  ops: { type: 'array', items: { anyOf: opSchemas } },
  rationale: { type: 'string' }, needsClarification: { type: ['string', 'null'] }
});

const isNum = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= PATCH_V2_LIMITS.coordinate;
const isPoint = v => Array.isArray(v) && v.length === 2 && v.every(isNum);
const keysAre = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const optional = (value, test) => value === null || value === undefined || test(value);
const intIn = (lo, hi) => v => Number.isInteger(v) && v >= lo && v <= hi;
// Strip nulls produced by strict schemas so the engine receives only intended fields.
const compact = value => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined));

function checkPen(p, where) {
  if (p === null || p === undefined) return {};
  if (!keysAre(p, ['color', 'style', 'width'])) fail('E_PATCH_SCHEMA', `${where}.pen`);
  if (!optional(p.color, intIn(0, 255)) || !optional(p.style, intIn(0, 255)) || !optional(p.width, intIn(0, 0xffff))) fail('E_PATCH_VALUE', `${where}.pen`);
  return compact(p);
}

function checkEntity(e, where, layers) {
  if (!e || typeof e !== 'object') fail('E_PATCH_SCHEMA', where);
  if (typeof e.layer !== 'string' || !LAYER.test(e.layer) || !layers.has(e.layer)) fail('E_PATCH_LAYER', `${where}.layer`);
  const expected = entitySchemas.find(s => s.properties.kind.enum[0] === e.kind);
  if (!expected || !keysAre(e, expected.required)) fail('E_PATCH_SCHEMA', `${where}.kind`);
  if (e.kind === 'line') {
    if (!isPoint(e.start) || !isPoint(e.end)) fail('E_PATCH_VALUE', where);
    if (e.start[0] === e.end[0] && e.start[1] === e.end[1]) fail('E_PATCH_ZERO_LENGTH', where);
    return { kind: 'line', layer: e.layer, start: e.start, end: e.end, pen: checkPen(e.pen, where) };
  }
  if (e.kind === 'text') {
    if (!isPoint(e.at) || typeof e.text !== 'string' || !e.text.length || e.text.length > PATCH_V2_LIMITS.text || /[\0\r]/u.test(e.text)) fail('E_PATCH_VALUE', where);
    for (const k of ['height', 'width', 'spacing']) if (!optional(e[k], v => isNum(v) && v >= 0 && v <= 1000)) fail('E_PATCH_VALUE', `${where}.${k}`);
    if (!optional(e.angle, isNum) || !optional(e.style, intIn(0, 10)) || !optional(e.color, intIn(0, 255))) fail('E_PATCH_VALUE', where);
    return compact({ kind: 'text', layer: e.layer, at: e.at, text: e.text, height: e.height, width: e.width, spacing: e.spacing, angle: e.angle, style: e.style, color: e.color });
  }
  if (e.kind === 'arc') {
    if (!isPoint(e.center) || !isNum(e.radius) || e.radius <= 0 || !isNum(e.startAngle) || !isNum(e.sweepAngle) || e.sweepAngle === 0 || Math.abs(e.sweepAngle) > 360) fail('E_PATCH_VALUE', where);
    if (!optional(e.flatness, v => isNum(v) && v > 0 && v <= 1000) || !optional(e.tilt, isNum)) fail('E_PATCH_VALUE', where);
    return compact({ kind: 'arc', layer: e.layer, center: e.center, radius: e.radius, startAngle: e.startAngle, sweepAngle: e.sweepAngle, flatness: e.flatness, tilt: e.tilt, pen: checkPen(e.pen, where) });
  }
  if (!isPoint(e.at)) fail('E_PATCH_VALUE', where);
  return { kind: 'point', layer: e.layer, at: e.at, pen: checkPen(e.pen, where) };
}

/**
 * Validate a Patch v2 against the IR it was generated from and return normalized ops.
 * Errors carry stable `.code` and a `.detail` path so a retry prompt can tell the model what to fix.
 */
export function validatePatchV2(patch, ir) {
  if (!ir || !Array.isArray(ir.entities) || !Array.isArray(ir.layers)) fail('E_PATCH_IR');
  if (!keysAre(patch, ['schemaVersion', 'sourceHash', 'units', 'ops', 'rationale', 'needsClarification'])) fail('E_PATCH_SCHEMA', 'root');
  if (patch.schemaVersion !== 2 || patch.units !== 'model-mm') fail('E_PATCH_SCHEMA', 'schemaVersion/units');
  if (patch.sourceHash !== ir.sourceHash) fail('E_PATCH_STALE');
  if (typeof patch.rationale !== 'string' || patch.rationale.length > 4000) fail('E_PATCH_SCHEMA', 'rationale');
  if (!optional(patch.needsClarification, v => typeof v === 'string' && v.length <= 2000)) fail('E_PATCH_SCHEMA', 'needsClarification');
  if (!Array.isArray(patch.ops) || patch.ops.length > PATCH_V2_LIMITS.ops) fail('E_PATCH_LIMIT', 'ops');
  if (!patch.ops.length && !patch.needsClarification) fail('E_PATCH_EMPTY');
  const layers = new Set(ir.layers.map(l => l.id)), live = new Set(ir.entities.map(e => e.id)), deleted = new Set(), temps = new Set();
  let idCount = 0;
  const resolve = (id, where) => {
    if (typeof id !== 'string') fail('E_PATCH_SCHEMA', where);
    if (deleted.has(id)) fail('E_PATCH_DELETED_TARGET', `${where}=${id}`);
    if (!live.has(id) && !temps.has(id)) fail('E_PATCH_ENTITY', `${where}=${id}`);
    return id;
  };
  const idList = (list, where) => {
    if (!Array.isArray(list) || !list.length || new Set(list).size !== list.length) fail('E_PATCH_SCHEMA', where);
    if ((idCount += list.length) > PATCH_V2_LIMITS.ids) fail('E_PATCH_LIMIT', 'ids');
    return list.map((id, i) => resolve(id, `${where}[${i}]`));
  };
  const ops = patch.ops.map((op, i) => {
    const where = `ops[${i}]`, schema = opSchemas.find(s => s.properties.op.enum[0] === op?.op);
    if (!schema || !keysAre(op, schema.required)) fail('E_PATCH_SCHEMA', where);
    switch (op.op) {
      case 'add': {
        if (op.tempId !== null && (typeof op.tempId !== 'string' || !TEMP.test(op.tempId) || temps.has(op.tempId) || live.has(op.tempId))) fail('E_PATCH_TEMP_ID', where);
        const entity = checkEntity(op.entity, `${where}.entity`, layers);
        if (op.tempId) temps.add(op.tempId);
        return op.tempId ? { op: 'add', tempId: op.tempId, entity } : { op: 'add', entity };
      }
      case 'delete': { const list = idList(op.ids, `${where}.ids`); list.forEach(id => deleted.add(id)); return { op: 'delete', ids: list }; }
      case 'translate':
        if (!isNum(op.dx) || !isNum(op.dy) || (op.dx === 0 && op.dy === 0)) fail('E_PATCH_VALUE', where);
        return { op: 'translate', ids: idList(op.ids, `${where}.ids`), dx: op.dx, dy: op.dy };
      case 'modify': {
        const id = resolve(op.id, `${where}.id`);
        if (!keysAre(op.set, modifySet.required)) fail('E_PATCH_SCHEMA', `${where}.set`);
        const set = compact(op.set);
        if (!Object.keys(set).length) fail('E_PATCH_EMPTY', `${where}.set`);
        for (const k of ['start', 'end', 'at', 'center']) if (k in set && !isPoint(set[k])) fail('E_PATCH_VALUE', `${where}.set.${k}`);
        for (const k of ['radius', 'startAngle', 'sweepAngle', 'height', 'width', 'angle']) if (k in set && !isNum(set[k])) fail('E_PATCH_VALUE', `${where}.set.${k}`);
        if ('radius' in set && set.radius <= 0) fail('E_PATCH_VALUE', `${where}.set.radius`);
        if ('text' in set && (!set.text.length || set.text.length > PATCH_V2_LIMITS.text || /[\0\r]/u.test(set.text))) fail('E_PATCH_VALUE', `${where}.set.text`);
        return { op: 'modify', id, set };
      }
      case 'setLayer':
        if (typeof op.layer !== 'string' || !LAYER.test(op.layer) || !layers.has(op.layer)) fail('E_PATCH_LAYER', `${where}.layer`);
        return { op: 'setLayer', ids: idList(op.ids, `${where}.ids`), layer: op.layer };
      case 'setPen': {
        const p = checkPen(op.pen, where);
        if (!Object.keys(p).length) fail('E_PATCH_EMPTY', `${where}.pen`);
        return { op: 'setPen', ids: idList(op.ids, `${where}.ids`), pen: p };
      }
    }
  });
  return { schemaVersion: 2, sourceHash: patch.sourceHash, ops, rationale: patch.rationale, needsClarification: patch.needsClarification ?? null };
}
