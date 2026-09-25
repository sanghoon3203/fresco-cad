import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogs, message } from '../ui/locales.mjs';

function flatten(value, prefix = '') {
  return Object.entries(value).flatMap(([key, item]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    return typeof item === 'object' ? flatten(item, name) : [[name, item]];
  });
}

test('English and Japanese catalogs have matching non-empty messages and placeholders', () => {
  const ja = new Map(flatten(catalogs['ja-JP']));
  const en = new Map(flatten(catalogs['en-US']));
  assert.deepEqual([...ja.keys()].sort(), [...en.keys()].sort());
  for (const [key, value] of ja) {
    assert.ok(typeof value === 'string' && value.trim(), key);
    assert.ok(typeof en.get(key) === 'string' && en.get(key).trim(), key);
    assert.deepEqual((value.match(/\{\w+\}/g) || []).sort(), (en.get(key).match(/\{\w+\}/g) || []).sort(), key);
  }
  assert.match(message('en-US', 'issueCount', { count: 3 }), /3/);
  assert.equal(message('en-US', 'captureMatchedStatus'), 'Bytes match metadata; origin unverified.');
  assert.match(message('ja-JP', 'captureRawUnverified'), /未検証/u);
  assert.match(message('en-US', 'captureMetadataTime'), /not trusted wall-clock time/u);
});
