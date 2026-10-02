# L4 regression corpus (Jw_cad opens our output)

No binary fixtures are committed here. `tools/jw-regress.mjs` generates them on every run, so they always match the
current engine. It writes everything to the untracked `outputs/l4/` folder at the repository root.

```
node tools/jw-regress.mjs --block <a JWW that contains block definitions> [--wait 15000] [--stable 4] [--only add-text,plans] [--no-jw]
```

- **base**: `generator/examples/plan-1ldk-46.json` drawn with `generator/draw-plan.mjs`, then cut down by the codec to
  about 200 entities (lines, text, arcs, points, solids). Jw_cad on the test PC draws slowly, and small files keep the
  captures stable.
- **op cases** (each is base + one Patch v2 applied with `applyPatchV2(..., { level: 'save' })`, so L1+L2+L3 must pass):
  translate-line, delete-line, modify-line, modify-text, add-line, add-text, add-arc, add-point, setLayer-line,
  setPen-line, and translate-block. The block case uses a codec-reduced copy of the `--block` file; block definitions
  and instances are kept.
- **plans**: every `generator/examples/*.json` drawn and opened without changes.

For each case the tool does the following:

1. It captures the before and after files in Jw_cad with `tools/jw-visual.ps1 -Mode shot`. This uses PrintWindow on the
   Jw_cad window only, which is parked off-screen. It never captures the desktop.
2. It diffs the captures inside the drawing area. The status bar is excluded because it repaints between captures; see
   the baseline repeatability in the report.
3. It renders before and after with our own renderer (`tools/render-png.mjs`). It then maps the renderer's change box
   to Jw_cad pixels through the paper frame that it detects in the capture.

Verdicts:

- `accepted`: the change is visible, localized (under 25% of the drawing area), and overlaps the expected box. Cases
  that should show nothing (a same-scale setLayer) count as accepted when nothing changes.
- `not-visible-in-capture (unverified)`: our renderer shows the change but the Jw_cad capture does not. On the test PC
  (2026-10-02) Jw_cad's PrintWindow capture holds only a deterministic **prefix** of the entity list: the same picture
  after 15 s or 45 s, and every repeat is identical. So entities late in the file (appended adds, text, arcs) are not
  in the capture. This is unverified, not a failure.
- `change-not-localized`, `change-elsewhere`: the check failed.
- `jw-capture-failed (E_VISUAL_*)`: Jw_cad did not reach a stable frame in time. Raise `--wait` / `--stable`.

Reports: `outputs/l4/report.json` and `outputs/l4/report.md`. Each case keeps its own folder with the JWW files and the
PNG captures and renders as evidence.
