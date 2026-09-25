# Diagnostic Jw_cad session staging

`New-JwCaptureSession.ps1` prepares a fresh directory for one manual Jw_cad diagnostic capture. It copies only `Capture-JwTemp.ps1` and the tested Shift-JIS `FRESCO_CAPTURE_SJIS.bat`, verifies their SHA-256 hashes, and writes `session.json`. It does not start Jw_cad or modify a drawing. The UTF8-named wrapper is deliberately excluded because Jw 10.3.6 classified it as Shift-JIS in the current test.

```powershell
$session = & .\addons\jw-assistant\bridge\New-JwCaptureSession.ps1
$session.WrapperPath
$session.TempFilePath
$session.ManifestPath
```

The default root is `%LOCALAPPDATA%\FrescoCAD\jw-sessions`. Each call creates a new GUID directory below it. `-SessionRoot` accepts an absolute path for an alternate root. If the Jw_cad installation differs from `C:\jww`, pass its existing executable as `-JwExePath` so staging also rejects that installation directory. The script rejects `C:\jww`, file roots, and existing reparse-point ancestors before writing. It does not overwrite or remove an existing directory.

`-JwExePath` validates the destination boundary; it does not edit the BAT's host path or launch the host. For another installation, the existing wrapper reads `FRESCO_JW_EXE_PATH` from the environment inherited when Jw was launched. Verify that environment separately before a diagnostic run. Paths must be fully qualified drive or UNC paths; drive-relative, current-drive-rooted and device paths are rejected.

Assign one returned `WrapperPath` to one Jw_cad window by manually selecting that BAT in the external transformation UI. Keep a written mapping between the window/drawing and `SessionDirectory`. Stage and select a separate wrapper for each window; run captures serially. Jw_cad's `#cd` directive writes `JWC_TEMP.TXT` beside the selected BAT, at the returned `TempFilePath`. The BAT then invokes the staged helper, which makes a byte-identical diagnostic capture under `%LOCALAPPDATA%\FrescoCAD\jw-captures`.

This directory separation is in place before Jw_cad invokes a BAT. It is only manual isolation: there is no native Jw_cad session binding, automatic window mapping, or launcher. Invoking the **same** wrapper twice concurrently can still replace its `JWC_TEMP.TXT` before the helper reads it. Do not treat a staged session or a capture as permission to write geometry. The bridge remains diagnostic, and native Undo behavior is unverified.

`session.json` records the source and staged hashes for the two package files, plus the session directory and safety flags. `JWC_TEMP.TXT` does not exist at staging time; Jw_cad creates it on invocation. Retain each session directory until its diagnostic run and any capture review are complete. Cleanup is manual and should target only the specific GUID directory you verified.
