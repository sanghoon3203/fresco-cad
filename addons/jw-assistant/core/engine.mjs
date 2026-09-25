const SNAPSHOT_KEYS = ['documentId', 'entities', 'revision', 'schemaVersion', 'units'];
const ENTITY_KEYS = ['color', 'end', 'id', 'kind', 'layer', 'lineType', 'start'];
const PROFILE_KEYS = ['allowedLayers', 'gapMm', 'id', 'shortLineMm', 'version'];
const PLAN_KEYS = [
  'baseRevision',
  'documentId',
  'issueIds',
  'profile',
  'profileSignature',
  'removals',
  'schemaVersion',
  'sourceSignature',
];

const MAX_ENTITIES = 100_000;
const MAX_PLAN_ITEMS = 200_000;
const MAX_GAP_COMPARISONS = 500_000;
const MAX_COORDINATE_MM = 1_000_000_000;
const MAX_TOLERANCE_MM = 1_000_000;
const MAX_REVISION = 2_147_483_646;

export const defaultProfile = Object.freeze({
  id: 'timber-basic',
  version: 1,
  shortLineMm: 0.5,
  gapMm: 5,
  allowedLayers: Object.freeze(['WALL', 'OPENING', 'GRID', 'ANNOTATION']),
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, expected, code, label) {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label} has unsupported or missing fields`);
  }
}

function requireIdentifier(value, code, label, maxLength = 128) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(value)
    || !isWellFormedUnicode(value)
  ) {
    fail(code, `${label} must be a non-empty bounded well-formed string without control characters`);
  }
}

function isWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function requireInteger(value, code, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(code, `${label} must be a safe integer in range`);
  }
}

function requireFiniteNumber(value, code, label, min, max, minInclusive = true) {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || (minInclusive ? value < min : value <= min)
    || value > max
  ) {
    fail(code, `${label} must be a finite number in range`);
  }
}

function validatePoint(point, entityId, field) {
  if (!Array.isArray(point) || point.length !== 2) {
    fail('E_POINT', `${entityId}.${field} must be a two-number point`);
  }
  for (const coordinate of point) {
    requireFiniteNumber(
      coordinate,
      'E_COORDINATE',
      `${entityId}.${field} coordinate`,
      -MAX_COORDINATE_MM,
      MAX_COORDINATE_MM,
    );
  }
}

function validateEntity(entity, index, seenIds) {
  if (!isRecord(entity)) fail('E_ENTITY', `entities[${index}] must be an object`);
  requireExactKeys(entity, ENTITY_KEYS, 'E_ENTITY_FIELDS', `entities[${index}]`);
  requireIdentifier(entity.id, 'E_ENTITY_ID', `entities[${index}].id`);
  if (seenIds.has(entity.id)) fail('E_DUPLICATE_ENTITY_ID', `duplicate entity id: ${entity.id}`);
  seenIds.add(entity.id);

  if (entity.kind !== 'line') fail('E_ENTITY_KIND', `unsupported entity kind: ${entity.kind}`);
  requireIdentifier(entity.layer, 'E_LAYER', `${entity.id}.layer`, 64);
  requireIdentifier(entity.color, 'E_COLOR', `${entity.id}.color`, 64);
  requireIdentifier(entity.lineType, 'E_LINE_TYPE', `${entity.id}.lineType`, 64);
  validatePoint(entity.start, entity.id, 'start');
  validatePoint(entity.end, entity.id, 'end');
}

export function validateSnapshot(snapshot) {
  if (!isRecord(snapshot)) fail('E_SNAPSHOT', 'snapshot must be an object');
  requireExactKeys(snapshot, SNAPSHOT_KEYS, 'E_SNAPSHOT_FIELDS', 'snapshot');
  if (snapshot.schemaVersion !== 1) fail('E_SCHEMA_VERSION', 'unsupported snapshot schemaVersion');
  requireIdentifier(snapshot.documentId, 'E_DOCUMENT_ID', 'documentId', 256);
  requireInteger(snapshot.revision, 'E_REVISION', 'revision', 0, MAX_REVISION);
  if (snapshot.units !== 'mm') fail('E_UNITS', 'snapshot units must be mm');
  if (!Array.isArray(snapshot.entities)) fail('E_ENTITIES', 'entities must be an array');
  if (snapshot.entities.length > MAX_ENTITIES) fail('E_ENTITY_LIMIT', 'snapshot has too many entities');

  const seenIds = new Set();
  snapshot.entities.forEach((entity, index) => validateEntity(entity, index, seenIds));
  return snapshot;
}

export function validateProfile(profile) {
  if (!isRecord(profile)) fail('E_PROFILE', 'profile must be an object');
  requireExactKeys(profile, PROFILE_KEYS, 'E_PROFILE_FIELDS', 'profile');
  requireIdentifier(profile.id, 'E_PROFILE_ID', 'profile.id', 128);
  requireInteger(profile.version, 'E_PROFILE_VERSION', 'profile.version', 1, MAX_REVISION);
  requireFiniteNumber(
    profile.shortLineMm,
    'E_SHORT_LINE_TOLERANCE',
    'profile.shortLineMm',
    0,
    MAX_TOLERANCE_MM,
  );
  requireFiniteNumber(
    profile.gapMm,
    'E_GAP_TOLERANCE',
    'profile.gapMm',
    0,
    MAX_TOLERANCE_MM,
    false,
  );
  if (!Array.isArray(profile.allowedLayers) || profile.allowedLayers.length === 0 || profile.allowedLayers.length > 256) {
    fail('E_ALLOWED_LAYERS', 'profile.allowedLayers must be a non-empty bounded array');
  }
  const seen = new Set();
  for (const layer of profile.allowedLayers) {
    requireIdentifier(layer, 'E_ALLOWED_LAYER', 'allowed layer', 64);
    if (seen.has(layer)) fail('E_DUPLICATE_ALLOWED_LAYER', `duplicate allowed layer: ${layer}`);
    seen.add(layer);
  }
  return profile;
}

function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('E_CANONICAL_VALUE', 'cannot canonicalize a nonfinite number');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  fail('E_CANONICAL_VALUE', 'cannot canonicalize this value');
}

function cloneProfile(profile) {
  return {
    id: profile.id,
    version: profile.version,
    shortLineMm: profile.shortLineMm,
    gapMm: profile.gapMm,
    allowedLayers: [...profile.allowedLayers],
  };
}

function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function squaredDistance(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function endpointOrder(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

function duplicateKey(entity) {
  const [first, second] = endpointOrder(entity.start, entity.end) <= 0
    ? [entity.start, entity.end]
    : [entity.end, entity.start];
  return canonicalize([
    entity.layer,
    entity.color,
    entity.lineType,
    first[0],
    first[1],
    second[0],
    second[1],
  ]);
}

function issueId(ruleId, parts) {
  return `${ruleId}/${parts.map((part) => encodeURIComponent(String(part))).join('/')}`;
}

function pushIssue(issues, issue) {
  if (issues.length >= MAX_PLAN_ITEMS) fail('E_RESOURCE_LIMIT', 'checker produced too many issues');
  issues.push(issue);
}

function checkExactDuplicates(snapshot, issues) {
  const firstByKey = new Map();
  for (const entity of snapshot.entities) {
    const key = duplicateKey(entity);
    const first = firstByKey.get(key);
    if (!first) {
      firstByKey.set(key, entity);
      continue;
    }
    pushIssue(issues, {
      id: issueId('exact-duplicate', [first.id, entity.id]),
      ruleId: 'exact-duplicate',
      severity: 'error',
      entityIds: [first.id, entity.id],
      location: midpoint(entity.start, entity.end),
      fixable: true,
      details: { keptEntityId: first.id, redundantEntityId: entity.id },
    });
  }
}

function checkPerEntity(snapshot, profile, issues) {
  const allowed = new Set(profile.allowedLayers);
  for (const entity of snapshot.entities) {
    const lengthSquared = squaredDistance(entity.start, entity.end);
    const lengthMm = Math.sqrt(lengthSquared);
    if (lengthSquared === 0) {
      pushIssue(issues, {
        id: issueId('zero-length', [entity.id]),
        ruleId: 'zero-length',
        severity: 'error',
        entityIds: [entity.id],
        location: [...entity.start],
        fixable: true,
        details: { lengthMm: 0 },
      });
    } else if (lengthMm < profile.shortLineMm) {
      pushIssue(issues, {
        id: issueId('short-line', [entity.id]),
        ruleId: 'short-line',
        severity: 'warning',
        entityIds: [entity.id],
        location: midpoint(entity.start, entity.end),
        fixable: false,
        details: { lengthMm, thresholdMm: profile.shortLineMm },
      });
    }
    if (!allowed.has(entity.layer)) {
      pushIssue(issues, {
        id: issueId('unknown-layer', [entity.id]),
        ruleId: 'unknown-layer',
        severity: 'warning',
        entityIds: [entity.id],
        location: midpoint(entity.start, entity.end),
        fixable: false,
        details: { layerId: entity.layer, profileId: profile.id },
      });
    }
  }
}

function checkNearGaps(snapshot, profile, issues) {
  const cellSize = profile.gapMm;
  const maxDistanceSquared = cellSize * cellSize;
  const buckets = new Map();
  let comparisons = 0;

  const endpoints = [];
  for (let entityIndex = 0; entityIndex < snapshot.entities.length; entityIndex += 1) {
    const entity = snapshot.entities[entityIndex];
    endpoints.push({ entity, entityIndex, endpoint: 'start', point: entity.start });
    endpoints.push({ entity, entityIndex, endpoint: 'end', point: entity.end });
  }

  for (const current of endpoints) {
    const cellX = Math.floor(current.point[0] / cellSize);
    const cellY = Math.floor(current.point[1] / cellSize);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const candidates = buckets.get(`${cellX + dx},${cellY + dy}`);
        if (!candidates) continue;
        for (const previous of candidates) {
          comparisons += 1;
          if (comparisons > MAX_GAP_COMPARISONS) {
            fail('E_RESOURCE_LIMIT', 'near-gap candidate work exceeded its bound');
          }
          if (previous.entity.id === current.entity.id) continue;
          if (previous.entity.layer !== current.entity.layer) continue;
          const distanceSquared = squaredDistance(previous.point, current.point);
          if (distanceSquared === 0 || distanceSquared > maxDistanceSquared) continue;
          const distanceMm = Math.sqrt(distanceSquared);
          pushIssue(issues, {
            id: issueId('near-gap', [
              previous.entity.id,
              previous.endpoint,
              current.entity.id,
              current.endpoint,
            ]),
            ruleId: 'near-gap',
            severity: 'warning',
            entityIds: [previous.entity.id, current.entity.id],
            location: midpoint(previous.point, current.point),
            fixable: false,
            details: {
              distanceMm,
              thresholdMm: profile.gapMm,
              firstEndpointId: previous.endpoint,
              secondEndpointId: current.endpoint,
            },
          });
        }
      }
    }
    const ownKey = `${cellX},${cellY}`;
    const ownBucket = buckets.get(ownKey);
    if (ownBucket) ownBucket.push(current);
    else buckets.set(ownKey, [current]);
  }
}

export function checkSnapshot(snapshot, profile = defaultProfile) {
  validateSnapshot(snapshot);
  validateProfile(profile);
  const issues = [];
  checkExactDuplicates(snapshot, issues);
  checkPerEntity(snapshot, profile, issues);
  checkNearGaps(snapshot, profile, issues);
  return issues;
}

function validateIssueIds(issueIds) {
  if (!Array.isArray(issueIds)) fail('E_ISSUE_IDS', 'issueIds must be an array');
  if (issueIds.length === 0) fail('E_EMPTY_PLAN', 'at least one issue is required');
  if (issueIds.length > MAX_PLAN_ITEMS) fail('E_RESOURCE_LIMIT', 'too many selected issues');
  const seen = new Set();
  for (const id of issueIds) {
    requireIdentifier(id, 'E_ISSUE_ID', 'issue id', 4096);
    if (seen.has(id)) fail('E_DUPLICATE_ISSUE_ID', `duplicate selected issue: ${id}`);
    seen.add(id);
  }
  return seen;
}

function buildPlan(snapshot, issueIds, profile) {
  if (snapshot.revision >= MAX_REVISION) {
    fail('E_REVISION_LIMIT', 'snapshot revision cannot be incremented');
  }
  const selected = validateIssueIds(issueIds);
  const issues = checkSnapshot(snapshot, profile);
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));

  for (const id of selected) {
    const issue = issueById.get(id);
    if (!issue) fail('E_UNKNOWN_ISSUE', `unknown current issue: ${id}`);
    if (!issue.fixable) fail('E_NONFIXABLE_ISSUE', `issue is advisory only: ${id}`);
  }

  const orderedIssueIds = issues.filter((issue) => selected.has(issue.id)).map((issue) => issue.id);
  const removals = [];
  const removalSet = new Set();
  for (const id of orderedIssueIds) {
    const issue = issueById.get(id);
    const removalId = issue.ruleId === 'exact-duplicate' ? issue.entityIds[1] : issue.entityIds[0];
    if (!removalSet.has(removalId)) {
      removalSet.add(removalId);
      removals.push(removalId);
    }
  }

  const copiedProfile = cloneProfile(profile);
  return {
    schemaVersion: 1,
    documentId: snapshot.documentId,
    baseRevision: snapshot.revision,
    sourceSignature: canonicalize(snapshot),
    profile: copiedProfile,
    profileSignature: canonicalize(copiedProfile),
    issueIds: orderedIssueIds,
    removals,
  };
}

export function createPlan(snapshot, issueIds, profile = defaultProfile) {
  validateSnapshot(snapshot);
  validateProfile(profile);
  return buildPlan(snapshot, issueIds, profile);
}

function validatePlanShape(plan) {
  if (!isRecord(plan)) fail('E_PLAN', 'plan must be an object');
  requireExactKeys(plan, PLAN_KEYS, 'E_PLAN_FIELDS', 'plan');
  if (plan.schemaVersion !== 1) fail('E_PLAN_SCHEMA_VERSION', 'unsupported plan schemaVersion');
  requireIdentifier(plan.documentId, 'E_PLAN_DOCUMENT_ID', 'plan.documentId', 256);
  requireInteger(plan.baseRevision, 'E_PLAN_REVISION', 'plan.baseRevision', 0, MAX_REVISION);
  if (typeof plan.sourceSignature !== 'string' || plan.sourceSignature.length === 0 || plan.sourceSignature.length > 64_000_000) {
    fail('E_PLAN_SIGNATURE', 'plan sourceSignature is invalid');
  }
  validateProfile(plan.profile);
  if (typeof plan.profileSignature !== 'string' || plan.profileSignature.length === 0 || plan.profileSignature.length > 64_000) {
    fail('E_PLAN_PROFILE_SIGNATURE', 'plan profileSignature is invalid');
  }
  validateIssueIds(plan.issueIds);
  if (!Array.isArray(plan.removals) || plan.removals.length === 0 || plan.removals.length > MAX_PLAN_ITEMS) {
    fail('E_PLAN_REMOVALS', 'plan removals must be a non-empty bounded array');
  }
  const seenRemovals = new Set();
  for (const id of plan.removals) {
    requireIdentifier(id, 'E_PLAN_REMOVAL_ID', 'removal id');
    if (seenRemovals.has(id)) fail('E_PLAN_DUPLICATE_REMOVAL', `duplicate removal: ${id}`);
    seenRemovals.add(id);
  }
}

function validatePlanAgainstSnapshot(snapshot, plan) {
  validateSnapshot(snapshot);
  validatePlanShape(plan);
  if (
    plan.documentId !== snapshot.documentId
    || plan.baseRevision !== snapshot.revision
    || plan.sourceSignature !== canonicalize(snapshot)
  ) {
    fail('E_STALE_PLAN', 'plan source no longer matches the snapshot');
  }
  if (plan.profileSignature !== canonicalize(plan.profile)) {
    fail('E_PLAN_TAMPERED', 'plan profile does not match its signature');
  }
  const expected = buildPlan(snapshot, plan.issueIds, plan.profile);
  if (canonicalize(plan) !== canonicalize(expected)) {
    fail('E_PLAN_TAMPERED', 'plan does not match regenerated allowlisted operations');
  }
  return expected;
}

function cloneEntity(entity) {
  return {
    id: entity.id,
    kind: entity.kind,
    layer: entity.layer,
    color: entity.color,
    lineType: entity.lineType,
    start: [...entity.start],
    end: [...entity.end],
  };
}

export function previewPlan(snapshot, plan) {
  const expected = validatePlanAgainstSnapshot(snapshot, plan);
  const removals = new Set(expected.removals);
  return {
    schemaVersion: 1,
    documentId: snapshot.documentId,
    revision: snapshot.revision + 1,
    units: 'mm',
    entities: snapshot.entities.filter((entity) => !removals.has(entity.id)).map(cloneEntity),
  };
}

export function applyPlan(snapshot, plan, approved) {
  if (approved !== true) fail('E_APPROVAL_REQUIRED', 'explicit approval is required');
  return previewPlan(snapshot, plan);
}
