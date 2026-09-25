# Fresco Jw Assistant — I2A office and site review

Windows Jw_cad companion foundation. The prototype now imports local JWC_TEMP captures for **read-only line checks**, alongside the synthetic editing demo. It does not parse/write JWW, modify real drawings, or call cloud AI. Installation and live host connection remain future gates.

## Run the review prototype

With Node.js 22 or later, from this directory:

```powershell
node tools/serve.mjs
```

Open `http://127.0.0.1:4318/ui/`. The server binds only to loopback and serves an explicit list of application assets. Local file selection reads bytes inside the browser without uploading them. No package installation is needed. Stop with Ctrl+C.

1. The synthetic timber line drawing is checked locally.
2. Select a finding to inspect its position and evidence.
3. Select fixable findings, then preview the exact removals.
4. Apply to the in-memory demo, cancel, or undo the preview edit.
5. Change Japanese/English and reduced motion in Settings.
6. Open the JSON review report in a read-only dialog and copy its contents. Browser file download is not assumed. The current demo edits are not persisted on reload.

Exact duplicates and zero-length lines are fixable. Short lines, nearby endpoints, and disallowed layers are advisory. The fixture is a diagnostic line arrangement, not a validated architectural plan.

## Import a capture

1. Select a completed capture copy of `JWC_TEMP.TXT` (maximum 8 MiB). Do not read the live temporary file while Jw is running an external transformation. Optionally select the matching `metadata.json` (maximum 64 KiB). The browser verifies the completion marker, byte lengths, SHA-256, timestamp format, and `hq` header. This verifies internal consistency, not the originating Jw window or the metadata author. Without metadata, the UI explicitly labels the raw import unverified.
2. Choose its actual encoding. The current UTF8-named diagnostic BAT was observed to produce CP932, so its filename does not establish encoding. Use the Shift-JIS wrapper for the tested diagnostic path.
3. Verify coordinate units against a known length, choose model mm or paper mm, and confirm. Unknown units block checking. Paper mm multiplies the chosen group scale; model mm does not. Do not guess from the drawing scale alone.
4. If multiple groups are present, choose one. Review excluded lines, unsupported records and blocking reasons. A ready line subset is not a complete drawing check.
5. Inspect findings and export the JSON report. Imported previews, apply and undo remain disabled; no host edits occur.

Invalid, incomplete, or mismatched selected metadata blocks checking and report export. Choosing another encoding or coordinate mode cannot bypass this check. To use a raw capture, explicitly remove the selected metadata. Older captures without the completion marker can still be reviewed this way. The report includes only the safe verification result, never filesystem paths from metadata.

Before a diagnostic Jw invocation, create a separate wrapper/helper directory with [session staging](../../docs/jw-assistant/session-staging.md). Each call prepares a GUID directory containing the tested SJIS wrapper. Manually select that wrapper in one Jw window and run serially. There is no automatic window binding or concurrency guarantee for reusing the same wrapper.

The included `fixtures/jwc-temp/jw-10.3.6-line-10000-shift-jis.txt` is an exact-byte capture of a purpose-drawn test line, not a client project. Choose Shift_JIS and model mm: group 0, scale 100, one line of 10,000 mm. `synthetic-mixed-groups.txt` exercises group isolation/partial coverage; `synthetic-blocked.txt` exercises unsupported multiline rejection. See [protocol evidence](../../docs/jw-assistant/importer-protocol-notes.md).

## Check

```powershell
node --test tests/*.test.mjs
```

The real Jw temporary-file capture utility has its own [instructions](bridge/README.md). Capture tests run from the repository root:

```powershell
pwsh -NoProfile -File tests/bridge_capture.test.ps1
pwsh -NoProfile -File tests/bridge_session.test.ps1
```

Both diagnostic BATs were invoked serially in Jw_cad 10.3.6 on one disposable line drawing. They produced matching CP932 captures and returned the visible `未実行` status with the line still present. This is limited evidence: UTF-8 recognition failed, and multi-group host calibration, concurrency isolation, saved-file equality, cancel/failure handling and native Undo remain open gates.

On 2026-09-25, a BOM-prefixed experimental copy was classified as UTF-8 in the Jw chooser. It was not executed or promoted to the shipped wrapper; UTF-8 end-to-end compatibility remains unverified. I1B adds manual directory separation, not verified simultaneous native operation.

## Documentation

- [Product requirements](../../docs/jw-assistant/requirements.md)
- [Module architecture and decisions](../../docs/jw-assistant/architecture.md)
- [Roadmap and real Jw acceptance gates](../../docs/jw-assistant/roadmap.md)
- [Design system and skill provenance](../../docs/jw-assistant/design.md)
- [I1 implementation report](../../docs/jw-assistant/sprint-02-i1-report.md)
- [I1B verification and session report](../../docs/jw-assistant/sprint-03-i1b-report.md)
- [Capture pair contract](../../docs/jw-assistant/capture-bundle-contract.md)
- [Initial prototype report](../../docs/jw-assistant/sprint-00-report.md)
- [Executable contract](CONTRACT.md)

The existing Qt/C++ Fresco CAD remains a separate project in this repository. No existing CAD engine source was changed for this prototype.

## Office and site review (I2A)

Imported reviews support versioned office rules, reasoned review decisions, local persistence, and safe CSV text export. The detailed layer starter provides 34 categories; confirm the actual group:layer mapping before saving. Site coordination notes check 12 handoff fields without approving construction. Japanese/English is available in Settings. These features do not alter CAD files.

Use one browser tab. Local data is specific to the browser and port. A site note is limited to one per checked context; save drafts before changing source or rules. View current JSON to preserve a manual copy. File-based restore remains planned. See [review contract](../../docs/jw-assistant/review-workflow.md), [field contract](../../docs/jw-assistant/field-coordination.md), and [Sprint 04 report](../../docs/jw-assistant/sprint-04-i2a-report.md).
