import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { verifyCapturePair } from '../jw-adapter/capture-bundle.mjs';

const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixture = new URL('../fixtures/jwc-temp/synthetic-mixed-groups.txt', import.meta.url);

function metadataFor(bytes) {
  const sha256 = hash(bytes);
  return {
    schemaVersion: 1,
    captureKind: 'jwc-temp-diagnostic',
    capturedAtUtc: '2026-09-25T09:12:34.1234567Z',
    publication: { status: 'complete' },
    source: { path: 'C:\\private\\client\\plan.jww', length: bytes.length,
      codec: 'ascii-compatible', sha256, hqFirstLinePreserved: true },
    capture: { path: 'C:\\private\\captures\\JWC_TEMP.TXT', length: bytes.length,
      sha256, byteIdentical: true },
  };
}

async function rejectsCode(bytes, metadata, code) {
  await assert.rejects(verifyCapturePair(bytes, encode(metadata)), (error) => error.code === code);
}

test('verifies the synthetic mixed-group JWC_TEMP fixture and exposes no metadata paths', async () => {
  const bytes = new Uint8Array(await readFile(fixture));
  const metadata = metadataFor(bytes);
  metadata.source.path = 'https://attacker.invalid/collect?secret=private-client';
  metadata.capture.path = '../../private-client/JWC_TEMP.TXT';
  const result = await verifyCapturePair(bytes, encode(metadata));
  assert.deepEqual(result, {
    integrity: 'matched', sourceAuthentication: 'unverified',
    capturedAtUtc: metadata.capturedAtUtc, sha256: hash(bytes),
    byteLength: bytes.length, codecHint: 'ascii-compatible',
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('attacker.invalid'), false);
});

test('rejects tampered capture bytes, hashes, lengths, and flags', async () => {
  const bytes = new Uint8Array(await readFile(fixture));
  const original = metadataFor(bytes);
  const tampered = Uint8Array.from(bytes);
  tampered[tampered.length - 1] ^= 1;
  await rejectsCode(tampered, original, 'E_BUNDLE_INTEGRITY');
  await rejectsCode(bytes, { ...original, source: { ...original.source, sha256: '0'.repeat(64) } }, 'E_BUNDLE_INTEGRITY');
  await rejectsCode(bytes, { ...original, capture: { ...original.capture, sha256: '0'.repeat(64) } }, 'E_BUNDLE_INTEGRITY');
  await rejectsCode(bytes, { ...original, source: { ...original.source, length: bytes.length + 1 } }, 'E_BUNDLE_INTEGRITY');
  await rejectsCode(bytes, { ...original, capture: { ...original.capture, length: bytes.length + 1 } }, 'E_BUNDLE_INTEGRITY');
  await rejectsCode(bytes, { ...original, source: { ...original.source, hqFirstLinePreserved: false } }, 'E_BUNDLE_INTEGRITY');
  await rejectsCode(bytes, { ...original, capture: { ...original.capture, byteIdentical: false } }, 'E_BUNDLE_INTEGRITY');
});

test('rejects incomplete, malformed, oversized, and implausible metadata', async () => {
  const bytes = new Uint8Array(await readFile(fixture));
  const original = metadataFor(bytes);
  await rejectsCode(bytes, { ...original, publication: { status: 'writing' } }, 'E_BUNDLE_INCOMPLETE');
  await rejectsCode(bytes, { ...original, publication: undefined }, 'E_BUNDLE_INCOMPLETE');
  for (const capturedAtUtc of ['2026-02-30T00:00:00Z', '2026-09-25T25:12:34Z',
    '2026-09-25T09:12:34+09:00', 'garbage']) {
    await rejectsCode(bytes, { ...original, capturedAtUtc }, 'E_BUNDLE_TIMESTAMP');
  }
  await rejectsCode(bytes, { ...original, source: { ...original.source, codec: 'utf-16' } }, 'E_BUNDLE_INTEGRITY');
  await assert.rejects(verifyCapturePair(bytes, new Uint8Array([0xff])), (error) => error.code === 'E_BUNDLE_METADATA');
  await assert.rejects(verifyCapturePair(bytes, new TextEncoder().encode('{')), (error) => error.code === 'E_BUNDLE_METADATA');
  await assert.rejects(verifyCapturePair(bytes, new Uint8Array(65537)), (error) => error.code === 'E_BUNDLE_OVERSIZE');
  await assert.rejects(verifyCapturePair(new Uint8Array(8 * 1024 * 1024 + 1), encode(original)),
    (error) => error.code === 'E_BUNDLE_OVERSIZE');
});

test('checks the actual first line even when metadata claims hq was preserved', async () => {
  const bytes = new TextEncoder().encode('xx\r\nhq\r\n');
  await rejectsCode(bytes, metadataFor(bytes), 'E_BUNDLE_HEADER');
  const bomHq = Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x71, 0x0d, 0x0a]);
  assert.equal((await verifyCapturePair(bomHq, encode(metadataFor(bomHq)))).integrity, 'matched');
});
