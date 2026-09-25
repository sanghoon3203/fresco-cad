import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewCsv } from '../review/export.mjs';

const contextKey = 'a'.repeat(64);
const issue = { id: 'short-line/1', ruleId: 'short-line', severity: 'warning', location: [-1, 2], entityIds: ['線1'] };
const review = { contextKey, issueId: issue.id, status: 'excluded', note: '意図した線', updatedAt: '2026-09-25T01:00:00.000Z' };

test('CSV preserves Japanese, quoted multiline notes and current context without claiming resolved', () => {
  const csv = reviewCsv([issue], [{ ...review, note: '意図した"線",\n詳細参照' }], contextKey);
  assert.ok(csv.startsWith('\uFEFF"context_key"'));
  assert.ok(csv.endsWith('\r\n'));
  assert.ok(csv.includes('"意図した""線"",\n詳細参照"'));
  assert.ok(csv.includes('"-1","2","線1","excluded"'));
  assert.ok(csv.includes(`"${contextKey}"`));
  assert.ok(reviewCsv([issue], [], contextKey).includes('"unreviewed"'));
  assert.ok(!csv.includes('resolved'));
});

test('CSV neutralizes formulas in notes, issue IDs and entity IDs, including whitespace prefixes', () => {
  for (const payload of ['=1+1', '+cmd', '-cmd', '@SUM(A1)', '  =1', '\tformula', '\rformula', '\nformula', '\u0001=1']) {
    const csv = reviewCsv([{ ...issue, id: payload, entityIds: [payload] }], [{ ...review, issueId: payload, note: payload }], contextKey);
    assert.equal(csv.split(`"'${payload}"`).length - 1, 3, payload);
  }
});

test('CSV rejects mixed contexts, duplicate records and non-finite coordinates', () => {
  const rejected = fn => assert.throws(fn, { code: 'E_REVIEW_EXPORT' });
  rejected(() => reviewCsv([issue], [review], 'bad'));
  rejected(() => reviewCsv([issue], [{ ...review, contextKey: 'b'.repeat(64) }], contextKey));
  rejected(() => reviewCsv([issue], [review, review], contextKey));
  rejected(() => reviewCsv([issue, issue], [], contextKey));
  rejected(() => reviewCsv([{ ...issue, location: [NaN, 0] }], [], contextKey));
  rejected(() => reviewCsv([issue], [{ ...review, status: 'resolved' }], contextKey));
});
