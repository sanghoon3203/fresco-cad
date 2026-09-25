import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { importJwcTemp } from '../jw-adapter/importer.mjs';
import { checkSnapshot, validateSnapshot } from '../core/engine.mjs';

const hs = `hs ${Array.from({ length: 16 }, (_, index) => index + 1).join(' ')}`;
const bytes = (lines) => new TextEncoder().encode(lines.join('\r\n'));
const confirmed = { encoding: 'utf-8', calibration: { source: 'user-confirmed', coordinateMode: 'paper-mm' } };
const base = ['hq', 'file=C:\\secret\\client.jww', 'hk 0', hs, 'lg1', 'ly2'];

test('rejects conflicting header placement and blocks unverified attribute or axis state', async () => {
  for (const rows of [[...base, 'hs ' + Array(16).fill(1).join(' ')], ['lg0', ...base], [...base, 'hk 0']]) {
    await assert.rejects(importJwcTemp(bytes(rows), confirmed), error => error.code === 'E_IMPORT_HEADER');
  }
  const missingAxis = await importJwcTemp(bytes(base.filter(row => row !== 'hk 0').concat('0 0 1 0')), confirmed);
  assert.equal(missingAxis.snapshot, null);
  const attributes = await importJwcTemp(bytes([...base, 'z1', '0 0 1 0']), confirmed);
  assert.equal(attributes.snapshot, null);
  assert.equal(attributes.coverage.supportedLines, 0);
});

test('imports a selected group as a core-valid snapshot without changing source bytes or exposing a path', async () => {
  const source = bytes([...base, 'lc1', 'lt2', 'lw3', '0 0 10 0', '10 0 0 0', 'lw4', '10 0 0 0']);
  const before = Uint8Array.from(source);
  const result = await importJwcTemp(source, confirmed);
  assert.deepEqual(source, before);
  assert.equal(result.source.sha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(result.coverage.status, 'ready');
  assert.equal(result.coverage.writeAllowed, false);
  assert.equal(validateSnapshot(result.snapshot), result.snapshot);
  assert.deepEqual(result.profile.allowedLayers, ['1:2']);
  assert.equal(result.metadata.groups[0].scale, 2);
  assert.equal(checkSnapshot(result.snapshot, result.profile).filter((issue) => issue.ruleId === 'exact-duplicate').length, 1);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('requires calibration and one group, excluding other-group lines from a selected snapshot', async () => {
  const source = bytes([...base, '0 0 10 0', 'lg2', 'ly3', '0 0 20 0']);
  const noGroup = await importJwcTemp(source, confirmed);
  assert.equal(noGroup.coverage.status, 'blocked');
  assert.equal(noGroup.snapshot, null);
  assert.equal(noGroup.coverage.reasons.some((item) => item.code === 'select-one-group'), true);

  const selected = await importJwcTemp(source, { ...confirmed, selectedGroup: '1' });
  assert.equal(selected.snapshot.entities.length, 1);
  assert.equal(selected.coverage.excludedGroupLines, 1);
  assert.deepEqual(selected.metadata.groups.map((group) => group.id), ['1', '2']);

  const uncalibrated = await importJwcTemp(source, { encoding: 'utf-8', selectedGroup: '1' });
  assert.equal(uncalibrated.snapshot, null);
  assert.equal(uncalibrated.source.coordinateMode, 'unknown');
});

test('paper coordinates multiply only the selected group scale and model coordinates do not', async () => {
  const scales = `hs ${[1, 100, ...Array(14).fill(1)].join(' ')}`;
  const source = bytes(['hq', 'hk 0', scales, 'lg1', 'ly0', '0 0 10 0']);
  const paper = await importJwcTemp(source, confirmed);
  assert.deepEqual(paper.snapshot.entities[0].end, [1000, 0]);
  const model = await importJwcTemp(source, {
    encoding: 'utf-8', calibration: { source: 'user-confirmed', coordinateMode: 'model-mm' },
  });
  assert.deepEqual(model.snapshot.entities[0].end, [10, 0]);
});

test('skips known nonline records but never mines numeric rows following unsupported multiline records', async () => {
  const partial = await importJwcTemp(bytes([...base, 'ci 0 0 10', 'ch 0 0 1 0 "label', '0 0 10 0']), confirmed);
  assert.equal(partial.coverage.status, 'partial');
  assert.equal(partial.coverage.unsupportedRecords, 2);
  assert.equal(partial.snapshot.entities.length, 1);

  const blocked = await importJwcTemp(bytes([...base, '0 0 10 0', 'pl', '10 10 20 20', '#', '0 0 20 0']), confirmed);
  assert.equal(blocked.coverage.status, 'blocked');
  assert.equal(blocked.snapshot, null);
  assert.equal(blocked.coverage.reasons.some((item) => item.code === 'unknown-or-multiline-record'), true);
  assert.equal(blocked.coverage.supportedLines, 1);
});

test('documented numeric headers are accepted and malformed values fail explicitly', async () => {
  const source = bytes(['hq', 'hk 0', hs, 'hcw 1 2 3 4 5 6 7 8 9 10', 'hch 1 2 3 4 5 6 7 8 9 10',
    'hcd 1 2 3 4 5 6 7 8 9 10', 'hcc 1 2 3 4 5 6 7 8 9 10', 'hn 0 0 100 100',
    'hzs 210 297', 'lg1', 'ly0', '0 0 1 0']);
  assert.equal((await importJwcTemp(source, confirmed)).coverage.status, 'ready');
  await assert.rejects(importJwcTemp(bytes(['hq', hs, 'hn 1 2 3']), confirmed),
    (error) => error.code === 'E_IMPORT_HEADER');
});

test('axis and bz markers block uncertain or conflicting coordinate interpretation', async () => {
  const angle = await importJwcTemp(bytes(['hq', 'hk 1.57', hs, 'lg1', 'ly0', '0 0 1 0']), confirmed);
  assert.equal(angle.snapshot, null);
  assert.equal(angle.metadata.axisAngle, 1.57);
  const bz = await importJwcTemp(bytes([...base, 'bz', '0 0 1 0']), confirmed);
  assert.equal(bz.snapshot, null);
  assert.equal(bz.coverage.reasons.some((item) => item.code === 'coordinate-mode-conflict'), true);
  const model = await importJwcTemp(bytes([...base, 'bz', '0 0 1 0']), {
    encoding: 'utf-8', calibration: { source: 'user-confirmed', coordinateMode: 'model-mm' },
  });
  assert.equal(model.coverage.status, 'ready');
});

test('rejects malformed numbers, decoding, oversized input, and invalid options with stable codes', async () => {
  const rejects = (code) => (error) => error.code === code;
  await assert.rejects(importJwcTemp(bytes([...base, '0 0 1']), confirmed), rejects('E_IMPORT_LINE'));
  await assert.rejects(importJwcTemp(bytes(['hq', 'hs 1']), confirmed), rejects('E_IMPORT_HS'));
  await assert.rejects(importJwcTemp(bytes([...base, 'NaN 0 1 2']), confirmed), rejects('E_IMPORT_LINE'));
  await assert.rejects(importJwcTemp(Uint8Array.of(0xff), confirmed), rejects('E_IMPORT_DECODING'));
  await assert.rejects(importJwcTemp(new Uint8Array(8 * 1024 * 1024 + 1), confirmed), rejects('E_IMPORT_OVERSIZE'));
  await assert.rejects(importJwcTemp(bytes(base), { encoding: 'utf-8', calibration: { source: 'guessed', coordinateMode: 'paper-mm' } }), rejects('E_IMPORT_CALIBRATION'));
});

test('Shift_JIS text payload is decoded but omitted from reports', async () => {
  const prefix = new TextEncoder().encode([...base, 'ch 0 0 1 0 "'].join('\r\n'));
  const suffix = new TextEncoder().encode('\r\n0 0 1 0');
  const source = Uint8Array.from([...prefix, 0x82, 0xa0, ...suffix]); // CP932 あ
  const result = await importJwcTemp(source, { ...confirmed, encoding: 'shift_jis' });
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.snapshot.entities.length, 1);
  assert.equal(JSON.stringify(result).includes('あ'), false);
});

test('real Jw 10.3.6 synthetic drawing capture imports as a 10000 mm model line', async () => {
  const capture = new Uint8Array(await readFile(new URL('../fixtures/jwc-temp/jw-10.3.6-line-10000-shift-jis.txt', import.meta.url)));
  const result = await importJwcTemp(capture, {
    encoding: 'shift_jis', calibration: { source: 'user-confirmed', coordinateMode: 'model-mm' },
  });
  assert.equal(result.source.sha256, 'c849c5ba847b13e0f432428e7e20dd68f1bc4cba7d5ef11f34d1f99318d6f656');
  assert.equal(result.coverage.status, 'ready');
  assert.equal(result.coverage.supportedLines, 1);
  assert.equal(result.metadata.groups[0].id, '0');
  assert.equal(result.metadata.groups[0].scale, 100);
  assert.deepEqual(result.snapshot.entities[0].start, [-5000, 0]);
  assert.deepEqual(result.snapshot.entities[0].end, [5000, 0]);
  assert.equal(JSON.stringify(result).includes('ＭＳ ゴシック'), false);
});
