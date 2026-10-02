# Plan spec (平面図 生成仕様)

A plan spec is a JSON document that an AI or a person writes; `drawPlan(spec)` turns it into a new JWW
(1/50 plan on group 1, A3 frame on group 0) following `knowledge/office-drafting-rules.json`.
Validate with `validateSpec(spec)` (`generator/spec.mjs`); the JSON Schema is exported as `PLAN_SPEC_SCHEMA`.
Examples: `generator/examples/*.json`.

CLI: `node tools/generate-plan.mjs spec.json out.jww --png out.png --report out.json`

## Units and frame
- Model millimetres. Grid line X1/Y1 is normally `(0, 0)`; x grows east, y grows north (top of the sheet).
- Everything structural sits on wall **centrelines** on the 尺モジュール: grid spacings, exterior vertices,
  interior wall ends and junctions must be multiples of **455** from the first grid line (error otherwise).
- Areas are centreline (壁芯) areas, as the office labels them (1,820 x 1,820 = 3.31 ㎡). 帖 = ㎡ / 1.62.

## Fields
| field | form | notes |
|---|---|---|
| `name` | string | file-safe id |
| `title` | `{project, drawing, scale, date, sheet}` | neutral text for the generated title strip (never client data) |
| `grid.x`, `grid.y` | `[0, 910, ...]` or `{pitch, count, start?}` | labels default to X1.. / Y1.. (`xLabels`, `yLabels` to override) |
| `exterior` | `[[x,y], ...]` | rectilinear outline (rectangle, L, T ...). Orientation is normalised. |
| `walls` | `[{id, from:[x,y], to:[x,y]}]` | horizontal/vertical interior walls (130 thick). Ends on another wall make T/L junctions; crossings make X junctions. |
| `openings` | see below | |
| `rooms` | `[{name, at, kind?, rect?, doma?, label?}]` | `at` = label centre (must be inside the room). `kind` is guessed from the name (living, bedroom, kitchen, wet, toilet, corridor, entrance, storage, other). `rect:[x1,y1,x2,y2]` splits an open-plan region (e.g. 玄関 vs ホール). `doma` = 土間 rectangle: tile hatch + 框 line where the doma meets free floor. |
| `items` | `[{type, at, rotation?, size?, label?}]` | equipment (1:6) and furniture (1:7). `at` = centre. The symbol's **back** is local -y; `rotation` 0/90/180/270 turns the back to S/E/N/W. Types: `ub1616 ub1216 toilet washbasin kitchen-i2550 kitchen-i2100 washer water-heater fridge bed-single bed-semidouble bed-double table-dining table-small sofa tv-board desk shoe-cabinet closet`. |
| `dims` | `{sides:['S','E','N','W'], first:1150, pitch:230}` | dimension tiers; the first tier is pushed beyond window tags automatically |
| `options` | `{insulation, hatch, auxGrid, tags, columns, northArrow}` | all default `true` |

### Openings
`{id, type, at, width, height?, hinge?, swing?, slide?, tag?}`
- `at`: centre on a wall centreline. `width`: **jamb-column centre span** (910 = 半間, 1820 = 1間). Rough opening = `width - 130`.
  Jamb columns off the 455 lattice are accepted with a warning and are dimensioned in a separate opening-position tier.
- `type`:
  - `window-sliding` (引違い窓, exterior walls only): office sash section (frame -217/-102, sashes -157/-136.5/-116, window board +80).
  - `door-swing` (片開き): `swing` = compass side the leaf opens into (N/S/E/W, perpendicular to the wall); `hinge` = `start`|`end` = the end with the lower / higher world coordinate.
  - `door-sliding` (片引き, leaf inside the wall plane): `slide` = `start`|`end`; needs a solid wall of the leaf length on that side (checked).
  - `door-sliding-double` (引違い戸, two leaves; closets).
  - `entrance-door` (玄関ドア, exterior): opens outward by default; leaf max 910, the rest of the module is a fixed side panel.
  - `opening` (passage, jamb boxes only; also used for the UB entrance).
- `height` (mm) and `tag` only feed the window tag text (`W1 / 1690×1100`).

## What the generator derives
Columns (corners, junctions, wall ends, jambs, <=1,820 along exterior walls), union-of-bodies wall faces with clean
corners/T-junctions, exterior assembly lines on mitred offset polygons, insulation wave + ±45° hatch clipped at openings,
labels with ㎡, three dimension tiers (opening positions if off-module / 455-multiple grid tier / overall) with 実点 ticks,
grid stubs + R150 bubbles on all four sides, title strip, north arrow.

## Planning rules the evaluator applies (so write specs that satisfy them)
Rooms reachable from the entrance through doors/openings; habitable rooms have a window; bath next to 洗面/脱衣 and
UB rotated so its entry is on the wash side (not the tub); corridors >= 780 clear (910 c/c) and circulation <= 12 %;
door swings clear of walls, other swings and furniture; 600 mm approach in front of every door free; kitchen aisle >= 800;
bed heads not against windows; items inside one room and off walls; bedrooms >= 4.5帖 with a 2.2 m clear side.
