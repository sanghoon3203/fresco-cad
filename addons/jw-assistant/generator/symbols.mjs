// Equipment (1:6, solid gray pen 7) and furniture (1:7, dashed pen 4) symbols in a local frame:
// centre at (0,0), width along x, depth along y, the BACK (wall side) at y = -depth/2, front at +depth/2.
// rotation (degrees CCW) turns the back toward: 0 = south(-y), 90 = east(+x), 180 = north, 270 = west.
// Sizes follow the office practice drawing (UB 1616 ~1650 sq in a 1820 module, I-kitchen 2550x650, washer pan 640).

const rr = (c, x1, y1, x2, y2, r) => { // rounded rectangle
  c.line([x1 + r, y1], [x2 - r, y1]); c.line([x2, y1 + r], [x2, y2 - r]); c.line([x2 - r, y2], [x1 + r, y2]); c.line([x1, y2 - r], [x1, y1 + r]);
  c.arc([x2 - r, y1 + r], r, 270, 90); c.arc([x2 - r, y2 - r], r, 0, 90); c.arc([x1 + r, y2 - r], r, 90, 90); c.arc([x1 + r, y1 + r], r, 180, 90);
};
const box = (c, x1, y1, x2, y2) => c.rect(x1, y1, x2, y2);

export const SYMBOLS = {
  ub1616: { role: 'equipment', size: [1650, 1650], label: 'UB1616', labelOffset: [250, 450], tubZone: [-825, -825, 5, 825], draw(c, [w, d]) {
    box(c, -w / 2, -d / 2, w / 2, d / 2);
    rr(c, -w / 2 + 40, -d / 2 + 40, -w / 2 + 790, d / 2 - 40, 60);          // tub rim
    rr(c, -w / 2 + 110, -d / 2 + 110, -w / 2 + 720, d / 2 - 110, 120);      // tub basin
    c.line([-w / 2 + 830, -d / 2], [-w / 2 + 830, d / 2]);                   // tub apron
    c.circle([w / 4, -d / 4], 45);                                           // floor drain
    box(c, w / 2 - 160, -60, w / 2 - 40, 60);                                // mixer tap
  } },
  ub1216: { role: 'equipment', size: [1250, 1650], label: 'UB1216', labelOffset: [0, 450], tubZone: [-625, -825, 625, -45], draw(c, [w, d]) {
    box(c, -w / 2, -d / 2, w / 2, d / 2);
    rr(c, -w / 2 + 40, -d / 2 + 40, w / 2 - 40, -d / 2 + 780, 60);
    rr(c, -w / 2 + 110, -d / 2 + 110, w / 2 - 110, -d / 2 + 710, 120);
    c.circle([0, d / 4], 45);
  } },
  toilet: { role: 'equipment', size: [450, 760], draw(c, [w, d]) {
    box(c, -w / 2, -d / 2, w / 2, -d / 2 + 200);                             // tank
    c.ellipse([0, -d / 2 + 200 + 270], 185, 270);                             // bowl rim
    c.ellipse([0, -d / 2 + 200 + 280], 130, 200);                             // bowl
    c.line([-150, -d / 2 + 200], [-185, -d / 2 + 470]); c.line([150, -d / 2 + 200], [185, -d / 2 + 470]);
  } },
  washbasin: { role: 'equipment', size: [750, 550], label: '洗面台', draw(c, [w, d]) {
    box(c, -w / 2, -d / 2, w / 2, d / 2);
    c.ellipse([0, 40], 250, 170);
    c.circle([0, -d / 2 + 80], 25);
  } },
  'kitchen-i2550': { role: 'equipment', size: [2550, 650], draw(c, [w, d]) { kitchen(c, w, d); } },
  'kitchen-i2100': { role: 'equipment', size: [2100, 650], draw(c, [w, d]) { kitchen(c, w, d); } },
  washer: { role: 'equipment', size: [640, 640], label: '洗濯機', draw(c, [w, d]) {
    box(c, -w / 2, -d / 2, w / 2, d / 2); box(c, -w / 2 + 40, -d / 2 + 40, w / 2 - 40, d / 2 - 40); c.circle([w / 2 - 110, d / 2 - 110], 40);
  } },
  'water-heater': { role: 'equipment', size: [600, 600], label: '給湯器', draw(c, [w, d]) { box(c, -w / 2, -d / 2, w / 2, d / 2); c.circle([0, 0], Math.min(w, d) / 2 - 60); } },
  fridge: { role: 'furniture', size: [700, 700], label: '冷蔵庫', draw(c, [w, d]) { box(c, -w / 2, -d / 2, w / 2, d / 2); c.line([-w / 2, -d / 2], [w / 2, d / 2]); } },
  'bed-single': { role: 'furniture', size: [1000, 2000], draw(c, s) { bed(c, s, 1); } },
  'bed-semidouble': { role: 'furniture', size: [1200, 2000], draw(c, s) { bed(c, s, 1); } },
  'bed-double': { role: 'furniture', size: [1400, 2000], draw(c, s) { bed(c, s, 2); } },
  'table-dining': { role: 'furniture', size: [1600, 900], pad: [0, 460, 0, 460], draw(c, [w, d]) {
    box(c, -w / 2, -d / 2, w / 2, d / 2);
    for (const x of [-w / 4, w / 4]) for (const sgn of [-1, 1]) { const y = sgn * (d / 2 + 260); c.rect(x - 220, y - 200, x + 220, y + 200); }
  } },
  'table-small': { role: 'furniture', size: [800, 800], pad: [0, 460, 0, 460], draw(c, [w, d]) {
    box(c, -w / 2, -d / 2, w / 2, d / 2);
    for (const sgn of [-1, 1]) { const y = sgn * (d / 2 + 260); c.rect(-220, y - 200, 220, y + 200); }
  } },
  sofa: { role: 'furniture', size: [2000, 850], draw(c, [w, d]) {
    box(c, -w / 2, -d / 2, w / 2, d / 2); c.line([-w / 2 + 180, -d / 2 + 200], [w / 2 - 180, -d / 2 + 200]);
    c.line([-w / 2 + 180, -d / 2 + 200], [-w / 2 + 180, d / 2]); c.line([w / 2 - 180, -d / 2 + 200], [w / 2 - 180, d / 2]);
  } },
  'tv-board': { role: 'furniture', size: [1800, 450], draw(c, [w, d]) { box(c, -w / 2, -d / 2, w / 2, d / 2); } },
  desk: { role: 'furniture', size: [1000, 600], pad: [0, 0, 0, 460], draw(c, [w, d]) { box(c, -w / 2, -d / 2, w / 2, d / 2); c.rect(-220, d / 2 + 60, 220, d / 2 + 460); } },
  'shoe-cabinet': { role: 'furniture', size: [900, 400], label: '下駄箱', draw(c, [w, d]) { box(c, -w / 2, -d / 2, w / 2, d / 2); c.line([-w / 2, d / 2], [w / 2, -d / 2]); } },
  closet: { role: 'furniture', size: [1820, 600], draw(c, [w, d]) {        // 枕棚 + ハンガーパイプ (dash-dot)
    c.line([-w / 2, d / 2 - 150], [w / 2, d / 2 - 150]);
    c.line([-w / 2, 0], [w / 2, 0], { style: 4 });
  } }
};
function kitchen(c, w, d) {
  box(c, -w / 2, -d / 2, w / 2, d / 2);
  rr(c, -w / 2 + 150, -d / 2 + 90, -w / 2 + 950, d / 2 - 110, 40);           // sink
  c.circle([-w / 2 + 550, -d / 2 + 160], 25);
  for (const [x, y] of [[w / 2 - 600, -60], [w / 2 - 300, -60], [w / 2 - 450, 150]]) c.circle([x, y], 95);  // hob
  box(c, w / 2 - 760, -d / 2 + 60, w / 2 - 140, d / 2 - 60);
}
function bed(c, [w, d], pillows) {
  box(c, -w / 2, -d / 2, w / 2, d / 2);
  const pw = pillows === 1 ? w - 300 : (w - 300) / 2;
  for (let k = 0; k < pillows; k++) { const x0 = -w / 2 + 150 + k * (pw + 0); c.rect(x0 + 10, -d / 2 + 60, x0 + pw - 10, -d / 2 + 340); }
  c.line([-w / 2, -d / 2 + 600], [w / 2, -d / 2 + 600]);
  c.line([-w / 2, -d / 2 + 600], [w / 2, -d / 2 + 1000]);
}

/** Local-to-world transform for an item at centre `at` rotated `rot` degrees. */
export function itemTransform(at, rot) {
  const a = rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return { rot, apply: ([x, y]) => [at[0] + x * c - y * s, at[1] + x * s + y * c] };
}
/** World corners and AABB of an item footprint. */
export function itemFootprint(at, rot, [w, d], pad = [0, 0, 0, 0]) {   // pad: extra [left, back, right, front] (chairs)
  const [pl, pb, pr, pf] = pad, T = itemTransform(at, rot), corners = [[-w / 2 - pl, -d / 2 - pb], [w / 2 + pr, -d / 2 - pb], [w / 2 + pr, d / 2 + pf], [-w / 2 - pl, d / 2 + pf]].map(T.apply);
  const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
  return { corners, rect: { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) } };
}
