import test from 'node:test';
import assert from 'node:assert/strict';
import {layerCategories,defaultLayerMap,validateLayerMap,categoryForLayer,blankFinishCard,finishFields,checkFinishCard,fieldContextKey,emptyFieldWorkspace,saveFinishCard,createFieldStore,handoffText} from '../field/standards.mjs';
const hash = 'a'.repeat(64);
test('starter categories are distinct; existing unmapped layers stay unknown', () => {
  assert.equal(layerCategories.length,34); const map = defaultLayerMap(); validateLayerMap(map);
  assert.equal(categoryForLayer([], '0:0'),null); assert.equal(categoryForLayer(map,'1:2'),'toilet');
  assert.throws(() => validateLayerMap([{categoryId:'door',layers:['0:0']},{categoryId:'window',layers:['0:0']}]),{code:'E_FIELD_MAPPING'});
});
test('completeness is never construction approval and identifies missing handoff data', () => {
  const card = blankFinishCard(); assert.equal(checkFinishCard(card).missing.length,12);
  for (const f of finishFields) card[f.id]='Verified by designer';
  assert.equal(checkFinishCard(card).status,'needs-designer-review'); assert.match(handoffText(card,'en-US'),/not an approved/);
});
test('source and mapping changes isolate site notes; mapping order is irrelevant', async () => {
  const map = defaultLayerMap(), key = await fieldContextKey(hash,map);
  assert.equal(key,await fieldContextKey(hash,[...map].reverse()));
  assert.notEqual(key,await fieldContextKey('b'.repeat(64),map)); assert.notEqual(key,await fieldContextKey(hash,[]));
  const original = emptyFieldWorkspace(), next = saveFinishCard(original,key,blankFinishCard()); assert.equal(original.cards.length,0); assert.equal(next.cards.length,1);
});
test('storage preserves previous good data and refuses stale or corrupt writes', () => {
  const data = new Map(), storage = {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)}, store=createFieldStore(storage);
  const initial=store.load(); const first=store.save({...initial,layerMap:defaultLayerMap()}); store.save(saveFinishCard(first,hash,blankFinishCard()));
  assert.equal(store.loadBackup().revision,1); assert.throws(()=>store.save(first),{code:'E_FIELD_CONFLICT'});
  data.set('fresco-jw-field-v1','broken'); assert.throws(()=>store.load(),{code:'E_FIELD_CORRUPT'}); assert.throws(()=>store.save(first)); assert.equal(data.get('fresco-jw-field-v1'),'broken');
});
