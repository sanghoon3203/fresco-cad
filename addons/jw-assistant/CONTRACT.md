# Jw Assistant executable contract — I1B

This local prototype supports synthetic review edits and read-only import of selected line records from JWC_TEMP. It does not parse/write JWW, return geometry to Jw_cad, or call an AI service. Production adapters must pass the real Jw_cad compatibility gates before enabling writes.

## Modules

- `core/engine.mjs`: dependency-free deterministic domain and checker; no browser, filesystem, network or provider imports.
- `jw-adapter/importer.mjs`: bounded, explicit-codec JWC_TEMP reader and coverage envelope; WebCrypto SHA-256, no filesystem/network access.
- `jw-adapter/capture-bundle.mjs`: verifies a caller-selected capture/metadata pair before import; no path following, host authentication, filesystem or network access. See [pair contract](../../docs/jw-assistant/capture-bundle-contract.md).
- `bridge/New-JwCaptureSession.ps1`: stages a unique manual diagnostic directory before Jw creates its temporary file; no native window binding or host launch.
- `fixtures/timber-plan.json`: synthetic line-only snapshot shared by tests and UI.
- `ui/index.html`, `ui/app.mjs`, `ui/styles.css`, `ui/locales.mjs`: local preview, review and settings.
- `tests/engine.test.mjs`: Node built-in test runner (`node --test tests/engine.test.mjs`).
- `tools/serve.mjs`: root-owned local development server.

## Snapshot v1

### Import envelope v1

`await importJwcTemp(bytes, {encoding, selectedGroup?, calibration?})` accepts `Uint8Array` (maximum 8 MiB), explicit `utf-8` or `shift_jis`, optional hexadecimal group ID, and optional `{coordinateMode: 'paper-mm'|'model-mm', source:'user-confirmed'}`. Missing calibration blocks checks. The codec is a user selection, not proof of host encoding. File names are not encoding evidence.

The result contains `schemaVersion:1`, `mode:'jwc-temp-read-only'`, `source:{encoding,byteLength,sha256,coordinateMode}`, `metadata:{axisAngle,scales,groups}`, `snapshot`, `profile`, `coverage`, and `diagnostics`. Group entries expose ID, scale and line count. Coverage exposes `status:'ready'|'partial'|'blocked'`, selectedGroup, supportedLines, unsupportedRecords, excludedGroupLines, reason codes and `writeAllowed:false`.

`ready` describes supported lines in the selected capture group; it never means the full drawing has been checked. Known nonline exclusions yield `partial`; unknown/stateful/multiline records, uncertain rotation, missing calibration or ambiguous group selection block Snapshot production. Imported group/layer IDs remain numeric; no wall semantics or office-standard compliance is inferred. Source paths and text payload are excluded from the envelope.

Calibration is explicit: model-mm remains unchanged; paper-mm is multiplied by the selected group's scale before Snapshot validation. In the first actual 10.3.6 capture, a 10,000 mm line at 1:100 was already emitted as 10,000 coordinate units without `bz`. Do not infer coordinate mode from scale or absence of `bz`. One captured case does not establish all host modes.

All real imports remain read-only at both UI controls and event handlers. Core mutation functions are only exposed by the synthetic demo. Choosing a new source or changing interpretation clears findings/plans from the previous source; async import completion must not replace a newer source. Captures have snapshot-local IDs, not durable Jw object identity. SHA-256 establishes content identity, not provenance/authentication.

When a metadata file is selected, loading, verification failure, or oversize input blocks import and report export until that metadata is successfully verified or explicitly removed. Changing options cannot silently fall back to raw import. A new capture selection clears the previous pair. Reports add `captureVerification` with a path-free verifier result, or `{integrity:'raw-unverified', sourceAuthentication:'unverified'}`. Verification never auto-selects a codec or establishes calibration.

### Line snapshot

```json
{"schemaVersion":1,"documentId":"synthetic-timber","revision":1,"units":"mm","entities":[{"id":"wall-1","kind":"line","layer":"WALL","color":"default","lineType":"solid","start":[0,0],"end":[3640,0]}]}
```

Only these line records are supported. Entity IDs are snapshot-local; they are not persistent Jw_cad IDs. Reject unsupported schema/units/entities, duplicate IDs, nonfinite or out-of-range numbers, and oversized input before checking or mutating. Keep CAD coordinates Cartesian Y-up in millimetres. Do not silently coerce strings to numbers.

## Core exports

`defaultProfile`: `{ id: 'timber-basic', version: 1, shortLineMm: 0.5, gapMm: 5, allowedLayers: ['WALL','OPENING','GRID','ANNOTATION'] }`.

`validateSnapshot(snapshot)`: throws Error with stable `.code` on invalid input, returns snapshot on success; no mutation.

`checkSnapshot(snapshot, profile = defaultProfile)`: returns deterministic ordered array of issues. Each issue: `{ id, ruleId, severity, entityIds, location: [x,y], fixable, details }`. Rules: `exact-duplicate` (same endpoints in either order AND same layer/color/lineType), `zero-length`, `short-line` (warning only), `near-gap` (warning only, never call it a proven broken wall), `unknown-layer` (warning only). No dimension-missing or semantic wall inference claims. details contains only structured numbers/IDs, no localized prose.

`createPlan(snapshot, issueIds, profile = defaultProfile)`: builds a plan only for current fixable issues; rejects empty, duplicate or unknown IDs and any nonfixable issue. Removes only redundant exact duplicates or zero-length lines. Plan includes `baseRevision`, exact canonical source signature, profile, issueIds, and removals. Duplicates keep the first occurrence. Zero-length/duplicate overlap must not delete a retained entity twice.

`previewPlan(snapshot, plan)`: validates the whole plan against the original snapshot/profile and returns candidate snapshot without mutating input. Detect stale snapshots even if revision is unchanged; reject tampered operations/profile. Recompute allowed plan from issueIds, compare expected full plan. Candidate revision = source revision + 1.

`applyPlan(snapshot, plan, approved)`: requires `approved === true`, then same validation and result as preview. No partial changes, files or Jw actions.

UI owns history of in-memory snapshots. Undo restores entities using a NEW monotonically increasing revision and clears existing plans. UI labels it “Undo preview edit”, never Jw native Undo.

## UI behavior

Default `ja-JP`, switch `en-US` in Settings and persist language preference. Review UI strings are in catalogs; field UI and definitions contain paired Japanese/English labels; IDs/units are stable. In demo mode: run check, choose an issue, fit preview to its location, select only fixable findings, preview changes, explicitly apply to demo, undo, cancel, reset demo, export JSON review report. Label the synthetic demo as such; label imported data read-only with its source and coverage. Display “Jw_cad not connected” in both modes. No fake cloud toggle: show unavailable provider status. Reduced motion follows OS and in-app preference. Keyboard accessible visible focus, status live region, safe textContent rendering. Semantic SEED foundations + restrained Apple-style feedback; precision geometry never animated.

## Office and field modules

See `docs/jw-assistant/review-workflow.md` and `docs/jw-assistant/field-coordination.md` at repository root. Semantic mapping is explicitly user-confirmed and never modifies CAD or the separate allowed-layer rule. Site field completeness is not specification validation or construction approval. Imported findings cannot invoke apply.
