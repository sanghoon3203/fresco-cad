# Portable project file v1 (I2D1)

Implemented 2026-09-28. This is a browser file session, the first slice of I2D. Native atomic saving, crash recovery and automatic previous-file retention remain open.

## Quick start

1. Open the local preview at `http://127.0.0.1:4318/ui/`.
2. Select **サンプルプロジェクトを試す**, check the model-mm/group-0 preview, then **内容を確認して開く**. The synthetic sample contains duplicate lines and an unsupported circle; it is not a construction drawing.
3. Save a review decision with **記録を保存**, or a location card with **確認メモを保存**.
4. Select **プロジェクトをダウンロード**. Check the downloaded `.jwproject.json` file, then select **ファイルの保存を確認した**.
5. Close the project, choose the downloaded file with **プロジェクトを選ぶ**, and confirm its preview. Decisions and site notes return under their original checked context.

For a real diagnostic capture, import it and explicitly confirm encoding, known units and group first. **現在の図面から作成** copies the current context's saved decisions/cards, office profile and layer map into a new UUID project. Unrelated browser records are excluded. A project fixes its capture, encoding, units and group; close it to select another source. Rules and mappings remain editable. Older context records remain in the file but are not automatically reattached to different rules or mappings.

## Format and validation

Exact root keys: `format: "fresco-jw-project"`, `schemaVersion: 1`, `id` (UUID), `name`, `savedAt` (UTC ISO), `capture`, `review`, `field`.

- `capture`: original filename, SHA-256, byte-preserving `base64`, optional `metadataBase64` (or null), explicit `encoding`, `coordinateMode`, hexadecimal `group`.
- `review`: existing strict review schema v1; `field`: existing strict field schema v2.
- Maximum project JSON: 16 MiB UTF-8. Capture: 8 MiB; metadata: 64 KiB; each saved workspace: existing 2 MiB bound and record limits.
- Open validates schema, bounds, canonical base64, source hash and optional metadata pair before switching sessions. It reruns the importer and checker; cached geometry or findings are never trusted or stored.
- Checksums establish internal consistency, not source authenticity. Raw capture and optional metadata bytes are embedded, so a project can contain original private annotations or paths even when those are omitted from a review report. Files stay local unless the user shares them.

## Session and saving behavior

Project stores use an isolated in-memory storage object. They do not write the browser's ordinary review/field localStorage keys. Closing returns to the preceding browser workspace and reselects its prior source. Separate recovery panels continue to work inside the project session; only their current primary workspaces enter the project export, not previous backups or quarantine history.

Saving a decision/card updates the session, not the project file on disk. Download is an explicit separate action, with a new timestamped filename. The app reports only a download request; the user confirms seeing the file. A changed workspace or outstanding draft invalidates that confirmation. Browser before-unload protection is best effort, not crash recovery. Keep exported files until the replacement has been reopened successfully.

Switching projects and normal close reject saved-but-unexported edits or active drafts. Closing with an explicit discard checkbox is available. Download rejects drafts; save or discard those first. All project actions temporarily disable editing while validating or switching. A malformed incoming file leaves the active workspace intact.

This format does not read/write `.jww`, `.jwc`, `.dxf`, `.dwg` or PDF documents directly. No CAD write-back, AI request or native host transaction is added.
