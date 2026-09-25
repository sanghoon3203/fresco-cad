import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { importJwcTemp } from '../jw-adapter/importer.mjs';
import { checkSnapshot } from '../core/engine.mjs';
import { emptyWorkspace, reviseProfile, createContextKey, recordReview, reviewsForContext } from '../review/store.mjs';
import { reviewCsv } from '../review/export.mjs';

test('reselected capture restores only the same checked context and retains excluded findings', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../fixtures/jwc-temp/synthetic-mixed-groups.txt', import.meta.url)));
  const options = { encoding: 'utf-8', selectedGroup: '0', calibration: { coordinateMode: 'model-mm', source: 'user-confirmed' } };
  const result = await importJwcTemp(bytes, options);
  const workspace = reviseProfile(emptyWorkspace(), { shortLineMm: 0.5, gapMm: 5, allowedLayers: ['0:0'] });
  const contextFor = (result, profile) => createContextKey({ sourceHash: result.source.sha256, encoding: result.source.encoding,
    coordinateMode: result.source.coordinateMode, groupId: result.coverage.selectedGroup, profile });
  const key = await contextFor(result, workspace.profile);
  const issues = checkSnapshot(result.snapshot, workspace.profile);
  const duplicate = issues.find(issue => issue.ruleId === 'exact-duplicate');
  assert.ok(duplicate);
  const recorded = recordReview(workspace, { contextKey: key, issueId: duplicate.id, status: 'excluded', note: '試験用の重複線' });
  const again = await importJwcTemp(bytes, options);
  assert.equal(await contextFor(again, recorded.profile), key);
  assert.equal(reviewsForContext(recorded, key).length, 1);
  assert.equal(checkSnapshot(again.snapshot, recorded.profile).length, issues.length);
  assert.ok(reviewCsv(issues, reviewsForContext(recorded, key), key).includes('"excluded"'));
  const revised = reviseProfile(recorded, { shortLineMm: 0.5, gapMm: 5, allowedLayers: ['0:1'] });
  assert.equal(reviewsForContext(revised, await contextFor(again, revised.profile)).length, 0);
  assert.ok(checkSnapshot(again.snapshot, revised.profile).some(issue => issue.ruleId === 'unknown-layer'));
  assert.deepEqual(again.snapshot, result.snapshot);
  assert.equal(result.coverage.writeAllowed, false);
  const anotherGroup = await importJwcTemp(bytes, { ...options, selectedGroup: '1' });
  assert.equal(reviewsForContext(recorded, await contextFor(anotherGroup, recorded.profile)).length, 0);
});
