import test from 'node:test';
import assert from 'node:assert/strict';
import {createDrafts} from '../field/drafts.mjs';
test('unsaved site drafts remain isolated across cards and checked contexts', () => {
  const drafts = createDrafts(), card = {location:'X1 / kitchen'};
  drafts.set('source-a','one',card); card.location='changed outside';
  drafts.set('source-a','two',{location:'X2 / toilet'});
  drafts.set('source-b','one',{location:'X3 / window'});
  assert.equal(drafts.get('source-a','one').location,'X1 / kitchen');
  assert.equal(drafts.forContext('source-a').length,2); assert.equal(drafts.size,3);
  drafts.get('source-a','one').location='tampered clone'; assert.equal(drafts.get('source-a','one').location,'X1 / kitchen');
  drafts.clear('source-a','one'); assert.equal(drafts.size,2); assert.equal(drafts.get('source-b','one').location,'X3 / window');
});
