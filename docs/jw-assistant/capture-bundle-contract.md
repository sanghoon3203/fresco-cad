# Diagnostic capture pair contract

`verifyCapturePair(captureBytes, metadataBytes)` accepts two caller-supplied `Uint8Array` values: the captured `JWC_TEMP.TXT` bytes and their `metadata.json` bytes. It uses browser APIs (`TextDecoder` and `crypto.subtle`) and performs no file reads, path resolution, or network requests. The caller must select both files. Metadata paths are ignored, including `source.path`, `capture.path`, and any future path fields.

The reader accepts schema version 1 and `captureKind: "jwc-temp-diagnostic"`. The metadata must contain `publication: { "status": "complete" }`; an absent or different status fails with `E_BUNDLE_INCOMPLETE`. The producer should publish that status only after the capture bytes and metadata are complete. Legacy metadata without the marker is not a verified pair.

The capture is limited to 8 MiB and the metadata to 64 KiB; empty files fail. Metadata must be strict UTF-8 JSON with object-valued top-level, `source`, `capture`, and `publication` fields. `capturedAtUtc` must be a valid UTC ISO timestamp ending in `Z`. `source.length` and `capture.length` must equal the supplied capture byte count. Both lowercase SHA-256 fields must equal each other and the computed digest. `source.hqFirstLinePreserved` and `capture.byteIdentical` must be `true`. The actual first capture line, after an optional UTF-8 BOM and ASCII horizontal whitespace, must be `hq`. `source.codec` must be one of `ascii-compatible`, `utf-8`, `utf-8-bom`, `shift-jis`, or `unknown`.

A successful call returns only:

```js
{
  integrity: 'matched',
  sourceAuthentication: 'unverified',
  capturedAtUtc: '2026-09-25T09:12:34.1234567Z',
  sha256: '…',
  byteLength: 1234,
  codecHint: 'shift-jis'
}
```

`codecHint` reports the producer's claim; it does not select or validate the import encoding. Hash agreement establishes that the supplied pair is internally consistent. It does not authenticate the host, the original Jw_cad source, the capture script, or the metadata author. The returned object contains no raw metadata or paths. Importing geometry remains a separate operation with an explicit encoding choice and the importer's calibration checks.

Failures use an `Error` with a stable `code`: `E_BUNDLE_BYTES` (wrong argument types), `E_BUNDLE_OVERSIZE` (size bounds or empty input), `E_BUNDLE_METADATA` (invalid JSON or schema), `E_BUNDLE_INCOMPLETE` (publication marker), `E_BUNDLE_TIMESTAMP` (invalid UTC timestamp), `E_BUNDLE_HEADER` (actual first line), or `E_BUNDLE_INTEGRITY` (length, hash, flags, or codec hint mismatch). Error messages do not include source or capture paths.
