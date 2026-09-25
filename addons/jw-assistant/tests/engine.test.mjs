import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  applyPlan,
  checkSnapshot,
  createPlan,
  defaultProfile,
  previewPlan,
  validateSnapshot,
} from '../core/engine.mjs';

const fixtureUrl = new URL('../fixtures/timber-plan.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));

function clone(value) {
  return structuredClone(value);
}

function line(id, start, end, layer = 'WALL', overrides = {}) {
  return {
    id,
    kind: 'line',
    layer,
    color: 'default',
    lineType: 'solid',
    start,
    end,
    ...overrides,
  };
}

function snapshot(entities, overrides = {}) {
  return {
    schemaVersion: 1,
    documentId: 'test-document',
    revision: 1,
    units: 'mm',
    entities,
    ...overrides,
  };
}

function profile(overrides = {}) {
  return {
    id: defaultProfile.id,
    version: defaultProfile.version,
    shortLineMm: defaultProfile.shortLineMm,
    gapMm: defaultProfile.gapMm,
    allowedLayers: [...defaultProfile.allowedLayers],
    ...overrides,
  };
}

function expectCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

test('validates by identity and checks the synthetic 910 mm timber plan without mutation', () => {
  const input = clone(fixture);
  const before = clone(input);

  assert.equal(validateSnapshot(input), input);
  const issues = checkSnapshot(input);

  assert.deepEqual(input, before);
  assert.deepEqual(
    issues.map(({ ruleId, entityIds, fixable }) => ({ ruleId, entityIds, fixable })),
    [
      {
        ruleId: 'exact-duplicate',
        entityIds: ['wall-south', 'wall-south-copy'],
        fixable: true,
      },
      { ruleId: 'zero-length', entityIds: ['annotation-zero'], fixable: true },
      { ruleId: 'short-line', entityIds: ['annotation-short'], fixable: false },
    ],
  );
});

test('exact duplicates match reversed endpoints but require identical style and layer', () => {
  const input = snapshot([
    line('kept', [0, 0], [910, 0]),
    line('reversed', [910, 0], [0, 0]),
    line('other-layer', [910, 0], [0, 0], 'OPENING'),
    line('other-color', [910, 0], [0, 0], 'WALL', { color: 'red' }),
    line('other-line-type', [910, 0], [0, 0], 'WALL', { lineType: 'dashed' }),
  ]);

  const duplicates = checkSnapshot(input).filter((issue) => issue.ruleId === 'exact-duplicate');
  assert.equal(duplicates.length, 1);
  assert.deepEqual(duplicates[0].entityIds, ['kept', 'reversed']);
  assert.equal(duplicates[0].details.keptEntityId, 'kept');
});

test('long valid Unicode IDs remain plannable and malformed Unicode gets a stable error', () => {
  const firstId = '壁'.repeat(128);
  const secondId = '線'.repeat(128);
  const input = snapshot([
    line(firstId, [0, 0], [910, 0]),
    line(secondId, [910, 0], [0, 0]),
  ]);
  const duplicate = checkSnapshot(input).find((issue) => issue.ruleId === 'exact-duplicate');
  assert.ok(duplicate.id.length > 1024);
  const plan = createPlan(input, [duplicate.id]);
  assert.deepEqual(previewPlan(input, plan).entities.map((entity) => entity.id), [firstId]);

  const malformed = snapshot([line('bad\uD800', [0, 0], [10, 0])]);
  assert.throws(() => checkSnapshot(malformed), expectCode('E_ENTITY_ID'));
});

test('short-line and near-gap tolerances have explicit boundaries and remain advisory', () => {
  const input = snapshot([
    line('left', [0, 0], [100, 0]),
    line('right', [104, 0], [200, 0]),
    line('short-below', [0, 100], [0.49, 100], 'ANNOTATION'),
    line('short-at-boundary', [0, 200], [0.5, 200], 'ANNOTATION'),
  ]);

  const atBoundary = checkSnapshot(input, profile({ gapMm: 4 }));
  const gap = atBoundary.find((issue) => issue.ruleId === 'near-gap');
  assert.deepEqual(gap.entityIds, ['left', 'right']);
  assert.equal(gap.details.distanceMm, 4);
  assert.equal(gap.fixable, false);
  assert.deepEqual(
    atBoundary.filter((issue) => issue.ruleId === 'short-line').map((issue) => issue.entityIds[0]),
    ['short-below'],
  );

  const belowBoundary = checkSnapshot(input, profile({ gapMm: 3.99 }));
  assert.equal(belowBoundary.some((issue) => issue.ruleId === 'near-gap'), false);
});

test('unknown layers are advisory and never enter an apply plan', () => {
  const input = snapshot([line('foreign', [0, 0], [910, 0], 'STRUCTURAL')]);
  const issue = checkSnapshot(input)[0];
  assert.equal(issue.ruleId, 'unknown-layer');
  assert.equal(issue.fixable, false);
  assert.throws(() => createPlan(input, [issue.id]), expectCode('E_NONFIXABLE_ISSUE'));
});

test('plans retain the first duplicate, remove allowlisted entities once, and return a new snapshot', () => {
  const input = clone(fixture);
  const before = clone(input);
  const fixable = checkSnapshot(input).filter((issue) => issue.fixable);
  const plan = createPlan(input, fixable.map((issue) => issue.id).reverse());

  assert.deepEqual(plan.removals, ['wall-south-copy', 'annotation-zero']);
  assert.deepEqual(plan.issueIds, fixable.map((issue) => issue.id));

  const candidate = previewPlan(input, plan);
  assert.notEqual(candidate, input);
  assert.equal(candidate.revision, input.revision + 1);
  assert.equal(candidate.entities.length, input.entities.length - 2);
  assert.equal(candidate.entities.some((entity) => entity.id === 'wall-south'), true);
  assert.equal(candidate.entities.some((entity) => entity.id === 'wall-south-copy'), false);
  assert.equal(candidate.entities.some((entity) => entity.id === 'annotation-zero'), false);
  assert.deepEqual(input, before);
});

test('overlapping zero-length and duplicate fixes never repeat a removal', () => {
  const input = snapshot([
    line('zero-kept', [10, 10], [10, 10]),
    line('zero-copy', [10, 10], [10, 10]),
  ]);
  const issues = checkSnapshot(input);
  const duplicate = issues.find((issue) => issue.ruleId === 'exact-duplicate');
  const copiedZero = issues.find(
    (issue) => issue.ruleId === 'zero-length' && issue.entityIds[0] === 'zero-copy',
  );

  const plan = createPlan(input, [duplicate.id, copiedZero.id]);
  assert.deepEqual(plan.removals, ['zero-copy']);
  assert.deepEqual(previewPlan(input, plan).entities.map((entity) => entity.id), ['zero-kept']);
});

test('apply requires literal approval and is identical to preview when approved', () => {
  const input = clone(fixture);
  const duplicate = checkSnapshot(input).find((issue) => issue.ruleId === 'exact-duplicate');
  const plan = createPlan(input, [duplicate.id]);

  assert.throws(() => applyPlan(input, plan, false), expectCode('E_APPROVAL_REQUIRED'));
  assert.throws(() => applyPlan(input, plan, 1), expectCode('E_APPROVAL_REQUIRED'));
  assert.deepEqual(applyPlan(input, plan, true), previewPlan(input, plan));
});

test('planning stops before candidate revision would leave the valid range', () => {
  const entities = [
    line('kept', [0, 0], [910, 0]),
    line('redundant', [910, 0], [0, 0]),
  ];
  const penultimate = snapshot(entities, { revision: 2_147_483_645 });
  const issue = checkSnapshot(penultimate).find((entry) => entry.ruleId === 'exact-duplicate');
  const candidate = previewPlan(penultimate, createPlan(penultimate, [issue.id]));
  assert.equal(candidate.revision, 2_147_483_646);
  assert.equal(validateSnapshot(candidate), candidate);

  const exhausted = snapshot(entities, { revision: 2_147_483_646 });
  assert.throws(() => createPlan(exhausted, [issue.id]), expectCode('E_REVISION_LIMIT'));
});

test('same-revision content changes make a plan stale through canonical snapshot equality', () => {
  const input = clone(fixture);
  const duplicate = checkSnapshot(input).find((issue) => issue.ruleId === 'exact-duplicate');
  const plan = createPlan(input, [duplicate.id]);
  const changed = clone(input);
  changed.entities.find((entity) => entity.id === 'wall-east').end[1] = 5459;

  assert.equal(changed.revision, input.revision);
  assert.throws(() => previewPlan(changed, plan), expectCode('E_STALE_PLAN'));
});

test('tampered operations and profiles are rejected atomically without touching the source', () => {
  const input = clone(fixture);
  const before = clone(input);
  const duplicate = checkSnapshot(input).find((issue) => issue.ruleId === 'exact-duplicate');
  const plan = createPlan(input, [duplicate.id]);

  const operationTamper = clone(plan);
  operationTamper.removals.push('wall-east');
  assert.throws(() => applyPlan(input, operationTamper, true), expectCode('E_PLAN_TAMPERED'));

  const profileTamper = clone(plan);
  profileTamper.profile.gapMm = 6;
  assert.throws(() => previewPlan(input, profileTamper), expectCode('E_PLAN_TAMPERED'));
  assert.deepEqual(input, before);
});

test('plan creation rejects empty, duplicate, unknown, and advisory selections', () => {
  const input = clone(fixture);
  const issues = checkSnapshot(input);
  const fixable = issues.find((issue) => issue.fixable);
  const advisory = issues.find((issue) => !issue.fixable);

  assert.throws(() => createPlan(input, []), expectCode('E_EMPTY_PLAN'));
  assert.throws(
    () => createPlan(input, [fixable.id, fixable.id]),
    expectCode('E_DUPLICATE_ISSUE_ID'),
  );
  assert.throws(() => createPlan(input, ['not-a-current-issue']), expectCode('E_UNKNOWN_ISSUE'));
  assert.throws(() => createPlan(input, [advisory.id]), expectCode('E_NONFIXABLE_ISSUE'));
});

test('validation rejects nonfinite, out-of-range, duplicate, unsupported, and oversized data', () => {
  const nonfinite = snapshot([line('bad-number', [0, 0], [Number.NaN, 0])]);
  assert.throws(() => validateSnapshot(nonfinite), expectCode('E_COORDINATE'));

  const outOfRange = snapshot([line('far-away', [0, 0], [1_000_000_001, 0])]);
  assert.throws(() => validateSnapshot(outOfRange), expectCode('E_COORDINATE'));

  const duplicateIds = snapshot([
    line('same', [0, 0], [10, 0]),
    line('same', [20, 0], [30, 0]),
  ]);
  assert.throws(() => validateSnapshot(duplicateIds), expectCode('E_DUPLICATE_ENTITY_ID'));

  const unsupported = snapshot([line('arc-like', [0, 0], [10, 0])]);
  unsupported.entities[0].kind = 'arc';
  assert.throws(() => validateSnapshot(unsupported), expectCode('E_ENTITY_KIND'));
  assert.throws(
    () => validateSnapshot(snapshot([], { schemaVersion: 2 })),
    expectCode('E_SCHEMA_VERSION'),
  );
  assert.throws(() => validateSnapshot(snapshot([], { units: 'm' })), expectCode('E_UNITS'));

  const oversized = snapshot(new Array(100_001).fill(null));
  assert.throws(() => validateSnapshot(oversized), expectCode('E_ENTITY_LIMIT'));
});

test('profile validation rejects nonfinite tolerances, duplicate layers, and unsupported fields', () => {
  const input = snapshot([line('valid', [0, 0], [910, 0])]);
  assert.throws(
    () => checkSnapshot(input, profile({ gapMm: Number.POSITIVE_INFINITY })),
    expectCode('E_GAP_TOLERANCE'),
  );
  assert.throws(
    () => checkSnapshot(input, profile({ allowedLayers: ['WALL', 'WALL'] })),
    expectCode('E_DUPLICATE_ALLOWED_LAYER'),
  );
  assert.throws(
    () => checkSnapshot(input, { ...profile(), surprise: true }),
    expectCode('E_PROFILE_FIELDS'),
  );
});

test('spatial buckets handle a large sparse drawing without quadratic pair scanning', () => {
  const entities = Array.from({ length: 10_000 }, (_, index) => {
    const x = index * 20;
    return line(`line-${index}`, [x, 0], [x + 10, 0]);
  });
  const input = snapshot(entities);
  assert.deepEqual(checkSnapshot(input), []);
});

test('dense near-gap candidates stop at the finite work bound', () => {
  const entities = Array.from({ length: 1_100 }, (_, index) =>
    line(`line-${index}`, [0, 0], [20 * index + 10, 0]));
  assert.throws(() => checkSnapshot(snapshot(entities)), expectCode('E_RESOURCE_LIMIT'));
});
