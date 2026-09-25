const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const CODEC_HINTS = new Set(['ascii-compatible', 'utf-8', 'utf-8-bom', 'shift-jis', 'unknown']);
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?Z$/u;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validUtcTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (Number(year) < 1 || Number(month) < 1 || Number(month) > 12
    || Number(day) < 1 || Number(day) > 31 || Number(hour) > 23
    || Number(minute) > 59 || Number(second) > 59) return false;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() + 1 === Number(month)
    && date.getUTCDate() === Number(day);
}

function firstLineIsHq(bytes) {
  let start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb
    && bytes[2] === 0xbf ? 3 : 0;
  let end = start;
  while (end < bytes.length && bytes[end] !== 0x0a && bytes[end] !== 0x0d) end += 1;
  while (start < end && (bytes[start] === 0x20 || bytes[start] === 0x09)) start += 1;
  while (end > start && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x09)) end -= 1;
  return end - start === 2 && bytes[start] === 0x68 && bytes[start + 1] === 0x71;
}

/** Verify two caller-supplied files as one completed diagnostic capture pair. */
export async function verifyCapturePair(captureBytes, metadataBytes) {
  if (!(captureBytes instanceof Uint8Array) || !(metadataBytes instanceof Uint8Array)) {
    fail('E_BUNDLE_BYTES', 'Capture and metadata must be Uint8Array values');
  }
  if (captureBytes.byteLength === 0 || captureBytes.byteLength > MAX_CAPTURE_BYTES
    || metadataBytes.byteLength === 0 || metadataBytes.byteLength > MAX_METADATA_BYTES) {
    fail('E_BUNDLE_OVERSIZE', 'Capture pair exceeds byte bounds or contains an empty file');
  }

  let metadata;
  try {
    metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(metadataBytes));
  } catch {
    fail('E_BUNDLE_METADATA', 'Metadata must be valid UTF-8 JSON');
  }
  if (!record(metadata) || metadata.schemaVersion !== 1
    || metadata.captureKind !== 'jwc-temp-diagnostic'
    || !record(metadata.source) || !record(metadata.capture)) {
    fail('E_BUNDLE_METADATA', 'Unsupported or malformed capture metadata');
  }
  if (!record(metadata.publication) || metadata.publication.status !== 'complete') {
    fail('E_BUNDLE_INCOMPLETE', 'Capture pair is not marked complete');
  }
  if (!validUtcTimestamp(metadata.capturedAtUtc)) {
    fail('E_BUNDLE_TIMESTAMP', 'Invalid UTC capture timestamp');
  }
  const { source, capture } = metadata;
  if (!Number.isSafeInteger(source.length) || !Number.isSafeInteger(capture.length)
    || source.length !== captureBytes.byteLength || capture.length !== captureBytes.byteLength
    || !SHA256_HEX.test(source.sha256) || !SHA256_HEX.test(capture.sha256)
    || source.sha256 !== capture.sha256 || source.hqFirstLinePreserved !== true
    || capture.byteIdentical !== true || !CODEC_HINTS.has(source.codec)) {
    fail('E_BUNDLE_INTEGRITY', 'Capture metadata does not match the supplied bytes');
  }
  if (!firstLineIsHq(captureBytes)) {
    fail('E_BUNDLE_HEADER', 'Capture does not begin with an hq line');
  }

  // Copy before digesting so caller mutation cannot alter the bytes being checked.
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(captureBytes));
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (sha256 !== source.sha256) {
    fail('E_BUNDLE_INTEGRITY', 'Capture SHA-256 does not match metadata');
  }
  return {
    integrity: 'matched',
    sourceAuthentication: 'unverified',
    capturedAtUtc: metadata.capturedAtUtc,
    sha256,
    byteLength: captureBytes.byteLength,
    codecHint: source.codec,
  };
}
