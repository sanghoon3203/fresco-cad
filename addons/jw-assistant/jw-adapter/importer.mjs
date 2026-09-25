import { validateSnapshot } from '../core/engine.mjs';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINES = 150_000;
const MAX_LINE_LENGTH = 16_384;
const MAX_COORDINATE = 1_000_000_000;
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const FOUR_NUMBERS = new RegExp(`^(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})$`, 'u');
const ONE_NUMBER = new RegExp(`^(${NUMBER})$`, 'u');
const MANY_NUMBERS = new RegExp(`^${NUMBER}(?:\\s+${NUMBER})*$`, 'u');
const HEX_ID = /^[0-9a-f]$/iu;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function parseNumbers(value, expression, code, lineNumber) {
  const match = expression.exec(value);
  if (!match) fail(code, `Malformed numeric record at line ${lineNumber}`);
  const numbers = match.slice(1).map(Number);
  if (numbers.some((number) => !Number.isFinite(number) || Math.abs(number) > MAX_COORDINATE)) {
    fail(code, `Out-of-range numeric record at line ${lineNumber}`);
  }
  return numbers;
}

function parseHeaderNumbers(value, count, lineNumber) {
  const parts = value.trim().split(/\s+/u);
  if (parts.length !== count || !MANY_NUMBERS.test(value.trim())) {
    fail('E_IMPORT_HEADER', `Malformed numeric header at line ${lineNumber}`);
  }
  for (const part of parts) parseNumbers(part, ONE_NUMBER, 'E_IMPORT_HEADER', lineNumber);
}

function reason(reasons, code, lineNumber, count) {
  const item = { code };
  if (lineNumber !== undefined) item.lineNumber = lineNumber;
  if (count !== undefined) item.count = count;
  reasons.push(item);
}

function optionsChecked(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || !['utf-8', 'shift_jis'].includes(options.encoding)) {
    fail('E_IMPORT_OPTIONS', 'Explicit utf-8 or shift_jis encoding is required');
  }
  if (options.selectedGroup !== undefined
    && (typeof options.selectedGroup !== 'string' || !HEX_ID.test(options.selectedGroup))) {
    fail('E_IMPORT_GROUP', 'selectedGroup must be a hexadecimal Jw group ID');
  }
  if (options.calibration !== undefined
    && (!options.calibration || options.calibration.source !== 'user-confirmed'
      || !['paper-mm', 'model-mm'].includes(options.calibration.coordinateMode))) {
    fail('E_IMPORT_CALIBRATION', 'Calibration must be user-confirmed paper-mm or model-mm');
  }
}

function splitBounded(text) {
  const lines = text.split(/\r\n|\n|\r/u);
  if (lines.length > MAX_LINES || lines.some((line) => line.length > MAX_LINE_LENGTH)) {
    fail('E_IMPORT_OVERSIZE', 'JWC_TEMP exceeds record bounds');
  }
  return lines;
}

function style(state) {
  // The core compares layer/color/lineType for duplicates. Carry every known
  // line style dimension through those fields so width and z never collapse.
  return {
    color: `jw-color:${state.color ?? 'unspecified'}`,
    lineType: `jw-type:${state.type ?? 'unspecified'};width:${state.width ?? 'unspecified'};z:${state.z ?? 'unspecified'}`,
  };
}

function parse(text) {
  const lines = splitBounded(text);
  if (lines.find((line) => line.trim())?.trim() !== 'hq') {
    fail('E_IMPORT_HEADER', 'The first nonempty record must be hq');
  }
  const records = [];
  const reasons = [];
  const diagnostics = [];
  const state = { group: null, layer: null, color: null, type: null, width: null, z: null };
  let axisAngle = null;
  let scales = null;
  let header = false;
  let bz = false;
  let unsupportedRecords = 0;
  let block = false;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line) continue;
    if (block) continue;
    if (line === 'hq') {
      if (header) fail('E_IMPORT_HEADER', 'Repeated diagnostic header');
      header = true; continue;
    }
    if (/^file=/iu.test(line)) continue; // Source filename is deliberately discarded.
    const headerNumbers = /^(hcw|hch|hcd|hcc|hn|hzs|hzk|hp\d{1,2}-?)(?:\s+)(.*)$/iu.exec(line);
    if (headerNumbers) {
      const [, token, values] = headerNumbers;
      parseHeaderNumbers(values, /^(?:hn|hzk)$/iu.test(token) ? 4
        : /^(?:hzs|hp)/iu.test(token) ? 2 : 10, lineNumber);
      continue;
    }
    if (/^hk(?:\s|$)/iu.test(line)) {
      if (axisAngle !== null || records.length) fail('E_IMPORT_HEADER', 'Repeated or late axis header');
      axisAngle = parseNumbers(line.slice(2).trim(), ONE_NUMBER, 'E_IMPORT_HK', lineNumber)[0];
      continue;
    }
    if (/^hs(?:\s|$)/iu.test(line)) {
      if (scales !== null || records.length) fail('E_IMPORT_HEADER', 'Repeated or late scale header');
      const parts = line.slice(2).trim().split(/\s+/u);
      if (parts.length !== 16) fail('E_IMPORT_HS', `Expected 16 scales at line ${lineNumber}`);
      scales = parts.map((part) => parseNumbers(part, ONE_NUMBER, 'E_IMPORT_HS', lineNumber)[0]);
      if (scales.some((scale) => scale <= 0)) fail('E_IMPORT_HS', `Invalid scale at line ${lineNumber}`);
      continue;
    }
    if (/^lg[0-9a-f]$/iu.test(line)) { state.group = line.slice(2).toUpperCase(); continue; }
    if (/^ly[0-9a-f]$/iu.test(line)) { state.layer = line.slice(2).toUpperCase(); continue; }
    if (/^lc10\s+\d+$/iu.test(line)) {
      const rgb = Number(line.slice(4).trim());
      if (!Number.isSafeInteger(rgb) || rgb < 0 || rgb > 16_777_215) {
        fail('E_IMPORT_COLOR', `Invalid RGB color at line ${lineNumber}`);
      }
      state.color = `rgb-${rgb}`;
      continue;
    }
    if (/^lc\d{1,6}$/iu.test(line)) { state.color = line.slice(2); continue; }
    if (/^lt\d{1,6}$/iu.test(line)) { state.type = line.slice(2); continue; }
    if (/^lw\d{1,6}$/iu.test(line)) { state.width = line.slice(2); continue; }
    // Attribute lifetime/grouping needs a host fixture before it can be treated
    // as ordinary line style. Let the unknown-record branch block these for now.
    // Jw's font-selection headers precede even line-only selections. They
    // alter text rendering, never the state used by our line snapshot.
    if (/^cn(?:\d{1,2}|"[^\r\n]*)$/iu.test(line)) continue;
    if (line === '#') continue; // documented geometry section separator
    if (line === 'bz') { bz = true; continue; }

    const four = FOUR_NUMBERS.exec(line);
    if (four) {
      const numbers = four.slice(1).map(Number);
      if (numbers.some((number) => !Number.isFinite(number) || Math.abs(number) > MAX_COORDINATE)) {
        fail('E_IMPORT_COORDINATE', `Invalid coordinate at line ${lineNumber}`);
      }
      if (state.group === null || state.layer === null) {
        block = true;
        reason(reasons, 'missing-group-or-layer', lineNumber);
      } else {
        records.push({ lineNumber, group: state.group, layer: state.layer,
          start: numbers.slice(0, 2), end: numbers.slice(2, 4), ...style(state) });
      }
      continue;
    }
    if (!block && /^[+-]?(?:\d|\.|NaN\b|Infinity\b)/iu.test(line)) {
      fail('E_IMPORT_LINE', `Malformed line record at line ${lineNumber}`);
    }
    // Circle, point, and text records are single-line nonline geometry. Their
    // payload is not included in any report or snapshot.
    if (/^(?:ci|cc|pt|pn|ch|cv|cs|cr|co|cp|ct|ck|cz|c2)(?:\s|\d|"|$)/iu.test(line)) {
      unsupportedRecords += 1;
      continue;
    }
    // Stop interpreting the remainder: an unknown command can introduce a
    // multiline section whose numeric rows must never become line records.
    block = true;
    unsupportedRecords += 1;
    reason(reasons, 'unknown-or-multiline-record', lineNumber);
  }

  if (!header) { block = true; reason(reasons, 'missing-hq'); }
  if (!scales) { block = true; reason(reasons, 'missing-hs'); }
  if (axisAngle === null || axisAngle !== 0) {
    block = true;
    reason(reasons, 'axis-angle-not-calibrated');
  }
  if (bz) diagnostics.push({ code: 'bz-model-mm-marker' });
  return { records, reasons, diagnostics, axisAngle, scales, bz, unsupportedRecords, block };
}

export async function importJwcTemp(bytes, options) {
  optionsChecked(options);
  if (!(bytes instanceof Uint8Array)) fail('E_IMPORT_BYTES', 'bytes must be Uint8Array');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
    fail('E_IMPORT_OVERSIZE', 'JWC_TEMP byte length is empty or exceeds limit');
  }
  const sourceBytes = Uint8Array.from(bytes);
  let text;
  try {
    text = new TextDecoder(options.encoding, { fatal: true }).decode(sourceBytes);
  } catch {
    fail('E_IMPORT_DECODING', 'JWC_TEMP cannot be decoded with the selected encoding');
  }
  if (text.includes('\0')) fail('E_IMPORT_DECODING', 'JWC_TEMP contains NUL');
  const hash = await crypto.subtle.digest('SHA-256', sourceBytes);
  const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const parsed = parse(text);
  const groups = [...new Set(parsed.records.map((record) => record.group))].sort();
  const selectedGroup = options.selectedGroup?.toUpperCase() ?? (groups.length === 1 ? groups[0] : null);
  const reasons = [...parsed.reasons];
  let blocked = parsed.block;
  if (groups.length > 1 && selectedGroup === null) {
    blocked = true;
    reason(reasons, 'select-one-group', undefined, groups.length);
  }
  if (selectedGroup !== null && !groups.includes(selectedGroup)) {
    blocked = true;
    reason(reasons, 'selected-group-absent');
  }
  if (groups.length === 0) {
    blocked = true;
    reason(reasons, 'no-supported-lines');
  }
  if (!options.calibration) {
    blocked = true;
    reason(reasons, 'coordinate-calibration-required');
  }
  if (parsed.bz && options.calibration?.coordinateMode === 'paper-mm') {
    blocked = true;
    reason(reasons, 'coordinate-mode-conflict');
  }
  const chosen = parsed.records.filter((record) => record.group === selectedGroup);
  const excludedGroupLines = parsed.records.length - chosen.length;
  if (chosen.length > 100_000) fail('E_IMPORT_OVERSIZE', 'Too many line entities');
  const groupScale = selectedGroup === null ? null : parsed.scales?.[parseInt(selectedGroup, 16)];
  if (selectedGroup !== null && (!Number.isFinite(groupScale) || groupScale <= 0)) {
    blocked = true;
    reason(reasons, 'selected-group-scale-unavailable');
  }
  const metadata = {
    axisAngle: parsed.axisAngle,
    scales: parsed.scales ?? [],
    groups: groups.map((id) => ({ id, scale: parsed.scales?.[parseInt(id, 16)] ?? null,
      lineCount: parsed.records.filter((record) => record.group === id).length })),
  };
  const profile = {
    id: 'jw-numeric-layers', version: 1, shortLineMm: 0.5, gapMm: 5,
    allowedLayers: [...new Set(chosen.map((record) => `${record.group}:${record.layer}`))].sort(),
  };
  // Core requires a nonempty allowlist even for a blocked or empty capture.
  if (profile.allowedLayers.length === 0) profile.allowedLayers.push('0:0');
  let snapshot = null;
  if (!blocked) {
    const factor = options.calibration.coordinateMode === 'paper-mm' ? groupScale : 1;
    const convert = (point) => point.map((coordinate) => {
      const mm = coordinate * factor;
      if (!Number.isFinite(mm) || Math.abs(mm) > MAX_COORDINATE) {
        fail('E_IMPORT_COORDINATE', 'Scaled coordinate exceeds supported range');
      }
      return mm;
    });
    snapshot = {
      schemaVersion: 1, documentId: `jwc-temp:${sha256}:${selectedGroup}`,
      revision: 0, units: 'mm',
      entities: chosen.map((record, index) => ({
        id: `line-${index + 1}`, kind: 'line', layer: `${record.group}:${record.layer}`,
        color: record.color, lineType: record.lineType,
        start: convert(record.start), end: convert(record.end),
      })),
    };
    validateSnapshot(snapshot);
  }
  if (parsed.unsupportedRecords > 0) reason(reasons, 'unsupported-nonline-records', undefined, parsed.unsupportedRecords);
  return {
    schemaVersion: 1,
    mode: 'jwc-temp-read-only',
    source: { encoding: options.encoding, byteLength: sourceBytes.byteLength, sha256,
      coordinateMode: options.calibration?.coordinateMode ?? 'unknown' },
    metadata, snapshot, profile,
    coverage: { status: blocked ? 'blocked' : parsed.unsupportedRecords > 0 ? 'partial' : 'ready',
      selectedGroup, supportedLines: chosen.length, unsupportedRecords: parsed.unsupportedRecords,
      excludedGroupLines, reasons, writeAllowed: false },
    diagnostics: parsed.diagnostics,
  };
}
