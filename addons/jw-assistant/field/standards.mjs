import { createJsonStore } from '../storage/local-store.mjs';

// Product starter proposal, not an industry standard or inferred source semantics.
const definitions = [
  ['exterior-wall','0:0','外壁','Exterior wall'], ['interior-wall','0:1','内壁・間仕切','Interior wall'],
  ['column','0:2','柱','Column'], ['beam','0:3','梁・桁','Beam'], ['grid','0:4','通り芯','Grid'],
  ['foundation','0:5','基礎','Foundation'], ['floor-base','0:6','床組・下地','Floor framing'], ['stair','0:7','階段','Stair'],
  ['furniture','1:0','家具','Furniture'], ['kitchen','1:1','キッチン','Kitchen'], ['toilet','1:2','便器','Toilet'],
  ['basin','1:3','洗面・流し','Basin / sink'], ['bath','1:4','浴槽・ユニットバス','Bath'],
  ['window','1:5','窓・サッシ','Window'], ['door','1:6','扉・建具','Door'], ['storage','1:7','造作収納','Built-in storage'],
  ['hvac','1:9','換気・空調','HVAC'], ['plumbing','1:A','給排水','Plumbing'], ['electrical','1:C','電気・照明','Electrical'],
  ['floor-finish','2:0','床仕上','Floor finish'], ['wall-finish','2:1','壁仕上','Wall finish'],
  ['ceiling-finish','2:2','天井仕上','Ceiling finish'], ['skirting','2:3','巾木・見切','Skirting / trim'],
  ['waterproof','2:4','防水','Waterproofing'], ['insulation','2:5','断熱・気密','Insulation / air barrier'],
  ['roof','2:6','屋根・軒','Roof / eaves'], ['joint','2:7','取合い・シール','Junction / sealant'],
  ['substrate','2:9','仕上下地','Finish substrate'], ['penetration','2:A','貫通・点検口','Penetration / access'],
  ['hatch','0:8','ハッチ','Hatch'], ['fill','0:B','色塗','Fill'], ['text','0:D','文字','Text'],
  ['dimension','0:E','寸法','Dimension'], ['auxiliary','0:F','補助線','Auxiliary'],
];
export const layerCategories = Object.freeze(definitions.map(([id, suggestedLayer, ja, en]) => Object.freeze({ id, suggestedLayer, ja, en })));
export const finishFields = Object.freeze([
  ['location','階・室・通り芯・面','Floor / room / grid / face'], ['drawingRef','図面番号・改訂','Drawing / revision'],
  ['detailRef','詳細図・仕様書の参照','Detail / specification reference'], ['material','仕上材・品番・色','Finish / product / colour'],
  ['substrate','下地・層構成','Substrate / build-up'], ['dimension','厚さ・幅・寸法単位','Thickness / width / units'],
  ['level','基準高さ・FL/GL','Datum / FL / GL'], ['junction','端部・取合い・見切','Edges / junctions / trim'],
  ['installation','施工方法・順序','Installation method / sequence'], ['coordination','設備・建具との調整','Services / openings coordination'],
  ['inspection','確認方法・検査時点','Inspection method / stage'], ['owner','担当・確認先','Responsible person / reviewer'],
].map(([id,ja,en]) => Object.freeze({id,ja,en})));
const HASH = /^[a-f0-9]{64}$/u;
const IDs = new Set(layerCategories.map(c => c.id));
const fail = code => { throw Object.assign(new Error(code), { code }); };
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail('E_FIELD_SCHEMA');
}
function text(value, max, empty = true) {
  if (typeof value !== 'string' || value.length > max || !value.isWellFormed() || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail('E_FIELD_TEXT');
}
export function defaultLayerMap() { return layerCategories.map(c => ({ categoryId: c.id, layers: [c.suggestedLayer] })); }
export function validateLayerMap(map) {
  if (!Array.isArray(map) || map.length > layerCategories.length) fail('E_FIELD_MAPPING');
  const categories = new Set(), layers = new Set();
  for (const entry of map) {
    exact(entry, ['categoryId','layers']);
    if (!IDs.has(entry.categoryId) || categories.has(entry.categoryId) || !Array.isArray(entry.layers) || entry.layers.length > 256) fail('E_FIELD_MAPPING');
    categories.add(entry.categoryId);
    for (const layer of entry.layers) {
      if (typeof layer !== 'string' || !/^[0-9A-F]:[0-9A-F]$/u.test(layer) || layers.has(layer)) fail('E_FIELD_MAPPING');
      layers.add(layer);
    }
  }
  return map;
}
export function categoryForLayer(map, layer) { validateLayerMap(map); return map.find(entry => entry.layers.includes(layer))?.categoryId ?? null; }
export function blankFinishCard(categoryId = 'wall-finish') { return { categoryId, ...Object.fromEntries(finishFields.map(f => [f.id, ''])) }; }
export function checkFinishCard(card) {
  exact(card, ['categoryId', ...finishFields.map(f => f.id)]);
  if (!IDs.has(card.categoryId)) fail('E_FIELD_CATEGORY');
  for (const f of finishFields) text(card[f.id], 600);
  const missing = finishFields.filter(f => !card[f.id].trim()).map(f => f.id);
  // Field completeness never becomes construction approval.
  return { missing, status: missing.length ? 'needs-information' : 'needs-designer-review' };
}
export async function fieldContextKey(reviewContextKey, map) {
  if (typeof reviewContextKey !== 'string' || !HASH.test(reviewContextKey)) fail('E_FIELD_CONTEXT');
  validateLayerMap(map);
  const ordered = map.map(e => ({ categoryId: e.categoryId, layers: [...e.layers].sort() })).sort((a,b) => a.categoryId.localeCompare(b.categoryId, 'en'));
  const bytes = new TextEncoder().encode(JSON.stringify({ schema: 1, reviewContextKey, map: ordered }));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('');
}
export function emptyFieldWorkspace() { return { schemaVersion: 1, revision: 0, layerMap: [], cards: [] }; }
export function validateFieldWorkspace(workspace) {
  exact(workspace, ['schemaVersion','revision','layerMap','cards']);
  if (workspace.schemaVersion !== 1 || !Number.isSafeInteger(workspace.revision) || workspace.revision < 0 || workspace.revision > 2147483646) fail('E_FIELD_SCHEMA');
  validateLayerMap(workspace.layerMap);
  if (!Array.isArray(workspace.cards) || workspace.cards.length > 100) fail('E_FIELD_LIMIT');
  const seen = new Set();
  for (const record of workspace.cards) {
    exact(record, ['contextKey','card','updatedAt']);
    if (typeof record.contextKey !== 'string' || !HASH.test(record.contextKey) || seen.has(record.contextKey)) fail('E_FIELD_CONTEXT');
    seen.add(record.contextKey); checkFinishCard(record.card);
    if (typeof record.updatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(record.updatedAt)
      || !Number.isFinite(Date.parse(record.updatedAt)) || new Date(record.updatedAt).toISOString() !== record.updatedAt) fail('E_FIELD_TIME');
  }
  if (new TextEncoder().encode(JSON.stringify(workspace)).length > 2*1024*1024) fail('E_FIELD_LIMIT');
  return workspace;
}
export function saveFinishCard(workspace, contextKey, card, now = new Date().toISOString()) {
  validateFieldWorkspace(workspace); checkFinishCard(card);
  const next = structuredClone(workspace);
  const record = { contextKey, card: structuredClone(card), updatedAt: now };
  const i = next.cards.findIndex(r => r.contextKey === contextKey);
  if (i < 0) next.cards.push(record); else next.cards[i] = record;
  return validateFieldWorkspace(next);
}
export function createFieldStore(storage) { return createJsonStore(storage, 'fresco-jw-field-v1', { initial: emptyFieldWorkspace, validate: validateFieldWorkspace, prefix: 'E_FIELD' }); }
export function handoffText(card, locale = 'ja-JP') {
  const result = checkFinishCard(card), ja = locale === 'ja-JP';
  const category = layerCategories.find(c => c.id === card.categoryId);
  return [ja ? '現場確認メモ — 工事指示・承認済図ではありません' : 'Site coordination note — not an approved construction instruction',
    `${ja ? '分類' : 'Category'}: ${ja ? category.ja : category.en}`,
    ...finishFields.map(f => `${ja ? f.ja : f.en}: ${card[f.id].trim() || (ja ? '未記入' : 'Missing')}`),
    ja ? `未記入 ${result.missing.length} 項目。設計者の確認が必要です。` : `${result.missing.length} missing fields. Designer review is required.`].join('\n');
}
