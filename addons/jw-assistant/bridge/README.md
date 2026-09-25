# Jw_cad diagnostic capture bridge

This bridge is a read-only diagnostic for the real Jw_cad external-transformation boundary. It copies the exact `JWC_TEMP.TXT` bytes into an application-local capture bundle and records hashes and environment metadata. It does not parse, rewrite, delete, or return geometry.

## Safety contract

- `Capture-JwTemp.ps1` opens the source with read access and `FileShare.Read`. An incompatible lock fails closed before a capture bundle is created.
- The source is never opened for write. The captured file is hashed and compared with the source bytes.
- A missing first-line `hq` fails before creating output. Final `metadata.json` is published by a same-directory rename only after copying and checking the bytes, with `publication.status: complete`. A failed run may leave an incomplete directory; it is not a verified pair.
- Capture destinations under `C:\jww` or the supplied executable's installation directory are rejected before creating files, even when executable metadata is omitted.
- All paths must be fully qualified drive or UNC paths. Drive-relative, current-drive-rooted, device paths and existing destination reparse-point ancestors are rejected.
- The wrappers contain no `hd`, output redirection, `copy`, `move`, or deletion command for `JWC_TEMP.TXT`.
- `hq` is intentionally left as the first line. The installed official sample documents this as the external-program-not-executed return, so Jw_cad should report the operation as not executed and leave the drawing unchanged.
- No Jw_cad Undo behavior is claimed or tested by this utility.

The checked-in wrappers use these documented directives from the installed official sample: `#jww`, `#cd`, `#hf`, `#h1`, `#hc`, `#g1`, and `#e`. `#cd` causes Jw_cad to create `JWC_TEMP.TXT` beside the selected BAT file. Captures go to `%LOCALAPPDATA%\FrescoCAD\jw-captures`; they never go into the Jw_cad installation directory.

`FRESCO_CAPTURE_UTF8.bat` has UTF-8 bytes without BOM; `FRESCO_CAPTURE_SJIS.bat` has Windows code page 932 bytes. **On 2026-09-24, Jw 10.3.6 classified both as S-JIS and both emitted CP932. The UTF8-named variant is not a working UTF-8 path.** Its Japanese prompt was garbled; the SJIS prompt was correct. Use SJIS for the currently tested diagnostic path. The helper's codec detector is a heuristic, not host evidence. The wrappers target the discovered installation at `C:\jww\JW_WIN.EXE`; set `FRESCO_JW_EXE_PATH` before launch for another verified installation.

This directory is not an installer. Do not copy a wrapper into `C:\jww`. Use `New-JwCaptureSession.ps1` to prepare a separate wrapper/helper directory per Jw session and invoke it serially; see [staging instructions](../../../docs/jw-assistant/session-staging.md). `#cd` creates a shared temporary filename per directory; the helper lock cannot prevent another invocation replacing it before capture begins. Staging provides manual directory separation, not an automatic session launcher or window authentication. Import only a completed capture copy, not the live JWC_TEMP file.

On 2026-09-25 the Jw 10.3.6 chooser classified an experimental BOM-prefixed copy as UTF-8; a UTF-8 Japanese first-line comment without BOM remained S-JIS. Neither candidate was executed. Keep using SJIS until BAT execution and UTF-8 output preservation are verified. See the [I1B report](../../../docs/jw-assistant/sprint-03-i1b-report.md).

## Stand-alone use

The capture tool can be tested without starting Jw_cad:

```powershell
pwsh -NoProfile -File .\addons\jw-assistant\bridge\Capture-JwTemp.ps1 `
  -SourcePath C:\absolute\path\JWC_TEMP.TXT `
  -CaptureRoot "$env:LOCALAPPDATA\FrescoCAD\jw-captures" `
  -JwExePath C:\jww\JW_WIN.EXE `
  -WrapperPath (Resolve-Path .\addons\jw-assistant\bridge\FRESCO_CAPTURE_SJIS.bat).Path
```

All path parameters must be absolute. Each capture has a unique directory containing the byte-identical `JWC_TEMP.TXT` and UTF-8 `metadata.json`.

The diagnostic helper defaults to a 64 MiB capture limit, while the current review UI accepts at most 8 MiB. Use smaller selections for UI review. The browser's [capture pair verifier](../../../docs/jw-assistant/capture-bundle-contract.md) does not follow paths in metadata and does not authenticate the capture's origin.

## Installed-source provenance

Read-only inspection on 2026-09-22 found:

- `C:\jww\JW_WIN.EXE`: file/product version `10.3.6.0`, SHA-256 `9f8daae501f85c5e80de39cd9339cab17322e655553720288d3b5cfb1b7fa2fc`.
- `C:\jww\JWW_SMPL.BAT`: 27,951 bytes, strict code page 932, SHA-256 `632ba1bd5d488c377689a8ec2783177d71706b97fe10e8ceb9fc6f93ebe046ef`.
- The sample describes external output at lines 289-318, `hq`/not-executed return at lines 291-293 and 514-517, and the separate destructive `hd` return at lines 522-523.

Official web provenance: [download](https://www.jwcad.net/download.htm) and [version history](https://www.jwcad.net/versioninfo.htm). Version 10.01.2 states that external-transformation data uses the BAT file's Shift-JIS or UTF-8 encoding.

## Pending real-machine gate

Both wrappers were launched serially on a disposable, unsaved, single-line drawing in a separate Jw 10.3.6 window on 2026-09-24. Both created a 389-byte CP932 capture with matching source/copy SHA-256 `c849c5ba847b13e0f432428e7e20dd68f1bc4cba7d5ef11f34d1f99318d6f656`. Jw displayed `未実行`, and the line remained visibly present. A native 10,000 mm line at scale 1:100 was emitted as `-5000 0 5000 0` without `bz`. The UTF8-named wrapper failed encoding recognition. [Full implementation report](../../../docs/jw-assistant/sprint-02-i1-report.md).

The following broader checks remain pending; visible line preservation is not proof of every host property:

1. Open a disposable drawing in exact version 10.3.6.0 and record its file hash or visible geometry.
2. Run each wrapper on a small selection whose text includes Japanese and ASCII.
3. Confirm a capture bundle is created with matching source/capture hashes and the expected BAT codec.
4. Confirm Jw_cad reports the documented not-executed result and that geometry, attributes, layer state, saved file bytes, and Undo history are unchanged.
5. Repeat from a path containing spaces and Japanese characters, then test a locked capture destination and denied write permissions.

Until this gate passes, the wrappers remain diagnostic fixtures and the application must continue to say “Jw_cad not connected.”
