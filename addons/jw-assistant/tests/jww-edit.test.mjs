import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hash, readJww } from '../native/jww.mjs';
import { toIR } from '../native/jww-pipeline.mjs';
import { validatePatchV2 } from '../core/patch-v2.mjs';
import { applyPatchV2, probeRewriteSafety, planNativeOps, verifyRewrite, textWidth, findUnrepresentable, staticRewriteProblems, isCp932 } from '../native/jww-edit.mjs';

const code = c => err => err.code === c;
const noSet = { start: null, end: null, at: null, center: null, radius: null, startAngle: null, sweepAngle: null, text: null, height: null, width: null, angle: null };
const noPen = { color: null, style: null, width: null };
const textOf = (at, text, extra = {}) => ({ kind: 'text', layer: '0:4', at, text, height: null, width: null, spacing: null, angle: null, style: null, color: null, ...extra });
const patchFor = (bytes, ops) => ({ schemaVersion: 2, sourceHash: hash(bytes), units: 'model-mm', ops, rationale: 'test', needsClarification: null });
const diffCount = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
// Writers differ on the exact text end (half-spacing rule vs uniform spacing); both must lie on the baseline within these bounds
// (in either order: a negative character spacing makes the uniform rule the shorter one).
const inRange = (along, text, sx, kan) => { const a = textWidth(text, sx, kan), b = textWidth(text, sx, kan, { uniformSpacing: true }); assert.ok(along >= Math.min(a, b) - 1e-9 && along <= Math.max(a, b) + 1e-9, `extent ${along}`); };
const approx = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${msg ?? ''} ${a} vs ${b}`);
const header = { m_nMojiShu: 10, m_dMojiSizeX: 10, m_dMojiSizeY: 10, m_dMojiKankaku: 1, m_nMojiColor: 5,
  m_adMojiX: [2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10], m_adMojiY: [2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10], m_adMojiD: [0, 0, 0.5, 0.5, 0.5, 1, 1, 1, 1, 1], m_anMojiCol: [1, 1, 2, 2, 3, 3, 4, 4, 5, 5] };

// ---- pure unit tests (no DLL) -------------------------------------------------------------------------------------------
const common = { m_lGroup: 0, m_sFlg: 0, m_nGLayer: 0, m_nLayer: 1, m_nPenWidth: 0, m_nPenColor: 2, m_nPenStyle: 1 };
const synthetic = () => ({
  version: 700, blockDefinitions: 0, images: 0, imageMetadata: [], blocks: [], diagnostics: [],
  layers: [...Array(16).keys()].flatMap(g => [...Array(16).keys()].map(l => ({ id: `${g.toString(16).toUpperCase()}:${l.toString(16).toUpperCase()}`, groupName: '', name: '', scale: g === 0 ? 100 : 1, state: 2 }))),
  entities: [
    { id: 'e0', type: 'JwwSen', props: { ...common, m_start_x: 1, m_start_y: 2, m_end_x: 3, m_end_y: 2 } },
    { id: 'e1', type: 'JwwMoji', props: { ...common, m_nLayer: 4, m_string: '洋室', m_strFontName: 'ＭＳ ゴシック', m_degKakudo: 0, m_dKankaku: 1, m_dSizeY: 10, m_dSizeX: 10, m_nMojiShu: 10, m_start_x: 5, m_start_y: 5, m_end_x: 25.9 - 0.9, m_end_y: 5 } },
    { id: 'e2', type: 'JwwEnko', props: { ...common, m_bZenEnFlg: 0, m_dHenpeiRitsu: 1, m_radKatamukiKaku: 0, m_radEnkoKaku: Math.PI / 2, m_radKaishiKaku: 0, m_dHankei: 5, m_start_x: 0, m_start_y: 0 } },
    { id: 'e3', type: 'JwwTen', props: { ...common, m_bKariten: 0, m_start_x: 7, m_start_y: 8 } },
    { id: 'e4', type: 'JwwBlock', props: { ...common, m_nNumber: 1, m_radKaitenKaku: 0, m_dBairitsuY: 1, m_dBairitsuX: 1, m_DPKijunTen_y: 1, m_DPKijunTen_x: 2 } },
    { id: 'e5', type: 'JwwSunpou', props: { ...common, m_bSxfMode: 0 }, components: [] }
  ]
});
const plan = (ops, doc = synthetic()) => planNativeOps(doc, validatePatchV2(patchFor(Buffer.alloc(0), ops), { sourceHash: hash(Buffer.alloc(0)), layers: doc.layers, entities: doc.entities }).ops, { header });

test('model mm converts to file units per layer group scale; text size stays paper mm', () => {
  const { nativeOps, expected } = plan([
    { op: 'translate', ids: ['e0', 'e3', 'e4'], dx: 910, dy: -455 },
    { op: 'add', tempId: null, entity: { kind: 'line', layer: '0:3', start: [0, 0], end: [1820, 0], pen: { color: 3, style: null, width: null } } },
    { op: 'add', tempId: null, entity: { kind: 'line', layer: '1:3', start: [0, 0], end: [1820, 0], pen: noPen } }
  ]);
  const set = i => nativeOps.find(o => o.op === 'set' && o.index === i);
  approx(set(0).props.m_start_x, 1 + 9.1); approx(set(0).props.m_end_y, 2 - 4.55);
  approx(set(3).props.m_start_x, 7 + 9.1); approx(set(4).props.m_DPKijunTen_x, 2 + 9.1); assert.equal(set(4).type, 'JwwBlock');
  const adds = nativeOps.filter(o => o.op === 'add');
  assert.deepEqual([adds[0].props.m_end_x, adds[0].props.m_nGLayer, adds[0].props.m_nLayer, adds[0].props.m_nPenColor, adds[0].props.m_nPenStyle, adds[0].props.m_sFlg], [18.2, 0, 3, 3, 1, 0]);
  assert.equal(adds[1].props.m_end_x, 1820);
  assert.equal(expected.length, 8);
});

test('text: header size by 文字種, angle in degrees, extent from Jw width rule, CP932 only', () => {
  const { nativeOps } = plan([
    { op: 'add', tempId: null, entity: textOf([910, 1820], '洋室 6帖', { style: 5 }) },
    { op: 'add', tempId: null, entity: textOf([0, 0], 'AB', { angle: 90, height: 4 }) },
    { op: 'add', tempId: null, entity: textOf([0, 0], 'x') }
  ]);
  const [a, b, c] = nativeOps.map(o => o.props);
  assert.deepEqual([a.m_string, a.m_dSizeX, a.m_dSizeY, a.m_dKankaku, a.m_nMojiShu, a.m_nPenColor, a.m_degKakudo], ['洋室 6帖', 5, 5, 0.5, 5, 3, 0]);
  approx(a.m_start_x, 9.1); approx(a.m_start_y, 18.2); approx(a.m_end_x, 9.1 + textWidth('洋室 6帖', 5, 0.5)); approx(a.m_end_y, 18.2);
  assert.deepEqual([b.m_dSizeX, b.m_dSizeY, b.m_nMojiShu, b.m_degKakudo, b.m_end_x, b.m_dKankaku], [10, 4, 0, 90, 0, 1]); // null width = drawing default
  approx(b.m_end_y, textWidth('AB', 10, 1)); assert.equal(textWidth('AB', 4, 1), 4.5); assert.equal(textWidth('AB', 4, 1, { uniformSpacing: true }), 5);
  assert.deepEqual([c.m_dSizeX, c.m_nMojiShu, c.m_nPenColor], [10, 10, 5]);
  assert.throws(() => plan([{ op: 'add', tempId: null, entity: textOf([0, 0], '😀') }]), code('E_JWW_TEXT_CHAR'));
  assert.throws(() => plan([{ op: 'add', tempId: null, entity: textOf([0, 0], 'a\nb') }]), code('E_JWW_TEXT_MULTILINE'));
  // Real Jw_cad extents: all full width, mixed, half-width ASCII gets half spacing.
  assert.equal(textWidth('５ｍラインの書き方', 10, 1), 98);
  assert.equal(textWidth('(b):横幅', 10, 1), 43);
  assert.equal(textWidth('d:四角管（端部断面線無）', 10, 1), 131);
});

test('arc fields: radians, negative sweep, full circle, flatness and tilt', () => {
  const arc = (extra, layer = '0:0') => plan([{ op: 'add', tempId: null, entity: { kind: 'arc', layer, center: [100, 200], radius: 500, startAngle: 30, sweepAngle: 90, flatness: null, tilt: null, pen: noPen, ...extra } }]).nativeOps[0].props;
  let p = arc({});
  assert.deepEqual([p.m_dHankei, p.m_start_x, p.m_start_y, p.m_bZenEnFlg, p.m_dHenpeiRitsu, p.m_radKatamukiKaku], [5, 1, 2, 0, 1, 0]);
  approx(p.m_radKaishiKaku, Math.PI / 6); approx(p.m_radEnkoKaku, Math.PI / 2);
  p = arc({ sweepAngle: -90 }); approx(p.m_radKaishiKaku, -Math.PI / 3 + 2 * Math.PI); approx(p.m_radEnkoKaku, Math.PI / 2);
  p = arc({ sweepAngle: 360, flatness: 0.5, tilt: 45 }); assert.deepEqual([p.m_bZenEnFlg, p.m_dHenpeiRitsu], [1, 0.5]); approx(p.m_radEnkoKaku, 2 * Math.PI); approx(p.m_radKatamukiKaku, Math.PI / 4);
  assert.equal(arc({}, '1:0').m_dHankei, 500);
});

test('tempIds fold into one add; add then delete vanishes; created map points at final ids', () => {
  const line = { kind: 'line', layer: '0:1', start: [0, 0], end: [100, 0], pen: noPen };
  const r = plan([{ op: 'add', tempId: 'n0', entity: line }, { op: 'translate', ids: ['n0'], dx: 200, dy: 0 }, { op: 'add', tempId: 'n1', entity: line }, { op: 'delete', ids: ['n1'] },
    { op: 'delete', ids: ['e3'] }, { op: 'add', tempId: 'n2', entity: line }]);
  assert.deepEqual(r.nativeOps.map(o => o.op), ['delete', 'add', 'add']);
  assert.equal(r.nativeOps[1].props.m_start_x, 2);
  assert.deepEqual(r.created, { n0: 'e5', n2: 'e6' });
  assert.equal(r.expected.length, 7);
});

test('setLayer keeps model position across scales; setPen/modify rules; unsupported kinds are refused with codes', () => {
  const r = plan([{ op: 'setLayer', ids: ['e0', 'e1', 'e2'], layer: '1:0' }, { op: 'setPen', ids: ['e0', 'e1'], pen: { color: 7, style: null, width: null } }]);
  const set = i => r.nativeOps.find(o => o.index === i).props;
  assert.deepEqual([set(0).m_start_x, set(0).m_end_x, set(0).m_nGLayer, set(0).m_nLayer, set(0).m_nPenColor], [100, 300, 1, 0, 7]);
  assert.equal(set(2).m_dHankei, 500);
  assert.equal(set(1).m_start_x, 500); approx(set(1).m_end_x - set(1).m_start_x, 20); // text extent is paper mm: unchanged by group scale
  assert.throws(() => plan([{ op: 'translate', ids: ['e5'], dx: 1, dy: 0 }]), code('E_JWW_UNSUPPORTED_ENTITY'));
  assert.throws(() => plan([{ op: 'setLayer', ids: ['e4'], layer: '1:0' }]), code('E_JWW_SETLAYER_SCALE'));
  assert.throws(() => plan([{ op: 'setPen', ids: ['e1'], pen: { color: null, style: 2, width: null } }]), code('E_JWW_PEN_UNSUPPORTED'));
  assert.throws(() => plan([{ op: 'setPen', ids: ['e0'], pen: { color: null, style: 100, width: null } }]), code('E_JWW_PEN_STYLE'));
  assert.throws(() => plan([{ op: 'modify', id: 'e0', set: { ...noSet, radius: 5 } }]), code('E_JWW_MODIFY_FIELD'));
  assert.throws(() => plan([{ op: 'modify', id: 'e0', set: { ...noSet, start: [200, 200], end: [200, 200] } }]), code('E_JWW_VALUE'));
  const m = plan([{ op: 'modify', id: 'e1', set: { ...noSet, text: 'ABC', angle: 90 } }]).nativeOps[0].props;
  assert.deepEqual([m.m_string, m.m_degKakudo, m.m_end_x], ['ABC', 90, 5]); approx(m.m_end_y, 5 + textWidth('ABC', 10, 1)); assert.equal(m.m_nMojiShu, undefined); // 文字種 untouched unless a size is set
  assert.equal(plan([{ op: 'modify', id: 'e1', set: { ...noSet, height: 4 } }]).nativeOps[0].props.m_nMojiShu, 0);
  const at = plan([{ op: 'modify', id: 'e1', set: { ...noSet, at: [1000, 1000] } }]).nativeOps[0].props;
  approx(at.m_end_x - at.m_start_x, 20);
});

test('CP932 detector and static rewrite checks refuse information-losing files', () => {
  for (const s of ['洋室 6帖', '㎡①㈱', 'ﾊﾝｶｸ', 'A\tB']) assert.deepEqual(findUnrepresentable(s), [], s);
  assert.deepEqual(findUnrepresentable('a😀b〜'), ['U+1F600', 'U+301C']);
  assert.ok(isCp932('～') && !isCp932('〜'));
  const bytes = bytes600 => { const b = Buffer.alloc(64); b.write('JwwData.', 'ascii'); b.writeInt32LE(bytes600, 8); return b; };
  const doc = synthetic(), withDimension = structuredClone(doc); doc.entities.pop();
  assert.deepEqual(staticRewriteProblems(bytes(700), doc), []);
  assert.match(staticRewriteProblems(bytes(700), withDimension)[0], /1 dimension entities/u);
  assert.match(staticRewriteProblems(bytes(300), doc)[0], /version 300/u);
  doc.entities[1].props.m_string = '洋室😀'; doc.layers[3].name = '階〜';
  const reasons = staticRewriteProblems(bytes(700), doc).join('|');
  assert.match(reasons, /e\d+\.m_string has U\+1F600/u); assert.match(reasons, /layer 0:3\.name has U\+301C/u);
  const ir = toIR(bytes(700), doc);
  return assert.rejects(applyPatchV2(bytes(700), patchFor(bytes(700), [{ op: 'delete', ids: ['e0'] }]), { ir, document: doc, writer: 'dll' }), err => err.code === 'E_JWW_REWRITE_UNSAFE' && /U\+1F600/u.test(err.message));
});

test('verifyRewrite flags every kind of drift and accepts an identical re-read', () => {
  const doc = synthetic(), same = () => structuredClone(doc), exp = d => d.entities.map(e => ({ from: e.id, type: e.type, props: e.props, touched: false, components: e.components }));
  assert.deepEqual(verifyRewrite(doc, exp(doc), same()), []);
  let d = same(); d.entities[0].props.m_end_x += 1e-9; assert.match(verifyRewrite(doc, exp(doc), d)[0], /e0\(was e0\)\.m_end_x/u);
  d = same(); d.entities.pop(); assert.match(verifyRewrite(doc, exp(doc), d)[0], /entity count/u);
  d = same(); d.layers[2].scale = 50; assert.match(verifyRewrite(doc, exp(doc), d)[0], /layers changed/u);
  d = same(); d.blocks = [{ id: 'b0' }]; assert.match(verifyRewrite(doc, exp(doc), d)[0], /blocks changed/u);
  d = same(); d.entities[3].type = 'JwwSen'; assert.match(verifyRewrite(doc, exp(doc), d)[0], /type JwwSen/u);
  d = same(); delete d.entities[0].props.m_sFlg; assert.match(verifyRewrite(doc, exp(doc), d)[0], /m_sFlg/u);
  assert.match(verifyRewrite(doc, exp(doc), same(), { headerBefore: { m_strMemo: 'a' }, headerAfter: { m_strMemo: 'b' } })[0], /header m_strMemo/u);
  assert.deepEqual(verifyRewrite(doc, exp(doc), same(), { headerBefore: { m_dEye_H_Ichi_1: 1, m_jwwDataVersion: 600 }, headerAfter: { m_dEye_H_Ichi_1: 0, m_jwwDataVersion: 700 } }), []);
});

// ---- native integration (real JwwHelper) --------------------------------------------------------------------------------
const fixture = process.env.FRESCO_JWW_FIXTURE, opts = { skip: !fixture, timeout: 300000 };
let shared;
const load = async () => shared ??= await (async () => { const bytes = await readFile(fixture), document = await readJww(bytes); return { bytes, document, ir: toIR(bytes, document) }; })();
const run = async (ops, writer) => { const { bytes, document, ir } = await load(); const result = await applyPatchV2(bytes, patchFor(bytes, ops), { ir, document, writer }); return { ...result, after: await readJww(result.bytes) }; };
const firstOf = (document, type, layerPrefix) => document.entities.findIndex(e => e.type === type && (!layerPrefix || e.props.m_nGLayer === layerPrefix[0]));
const scaleOf = (document, p) => document.layers.find(l => l.id === `${p.m_nGLayer.toString(16).toUpperCase()}:${p.m_nLayer.toString(16).toUpperCase()}`).scale;

test('native: no-op rewrite of Test1 - codec is byte exact, the DLL writer is semantically safe only', opts, async () => {
  const { bytes, document } = await load();
  const codec = await probeRewriteSafety(bytes, { document });
  assert.deepEqual(codec.reasons, []); assert.equal(codec.safe, true); assert.equal(codec.writer, 'codec'); assert.equal(codec.byteExact, true); assert.equal(codec.differingBytes, 0);
  const dll = await probeRewriteSafety(bytes, { document, writer: 'dll' });
  assert.deepEqual(dll.reasons, []); assert.equal(dll.safe, true);
  assert.equal(dll.byteExact, false); assert.ok(dll.differingBytes > 0 && dll.differingBytes < 200, `differingBytes ${dll.differingBytes}`);
});

test('native: translate a line, others untouched, input never modified', opts, async () => {
  const { bytes, document, ir } = await load(), i = firstOf(document, 'JwwSen'), id = `e${i}`;
  const result = await run([{ op: 'translate', ids: [id], dx: 910, dy: -455 }]);
  assert.equal(result.receipt.verified, true); assert.equal(result.receipt.writer, 'codec'); assert.equal(result.receipt.byteExact, false); assert.equal(result.receipt.byteExactOutsideEdits, true);
  assert.equal(result.bytes.length, bytes.length); assert.ok(diffCount(bytes, result.bytes) <= 32, 'only the 32 coordinate bytes of one line change');
  assert.equal(result.receipt.sourceHash, hash(bytes)); assert.equal(result.receipt.outputHash, hash(result.bytes));
  const before = ir.entities[i], got = result.ir.entities[i];
  [910, -455, 910, -455].forEach((d, k) => approx(got.points[k], before.points[k] + d, 'point'));
  result.ir.entities.forEach((e, k) => { if (k !== i) assert.deepEqual(e.points, ir.entities[k].points); });
  assert.equal(result.ir.entities.length, ir.entities.length);
  assert.deepEqual(await readFile(fixture), bytes);
});

test('native: delete removes exactly those entities and shifts ids', opts, async () => {
  const { document } = await load(), result = await run([{ op: 'delete', ids: ['e5', 'e10'] }]);
  assert.equal(result.after.entities.length, document.entities.length - 2);
  const kept = document.entities.filter((_, k) => k !== 5 && k !== 10);
  kept.forEach((e, k) => assert.deepEqual(result.after.entities[k].props, e.props));
});

test('native: modify line end, text string and arc radius', opts, async () => {
  const { document } = await load(), line = firstOf(document, 'JwwSen'), moji = firstOf(document, 'JwwMoji'), arc = firstOf(document, 'JwwEnko');
  const scale = scaleOf(document, document.entities[line].props);
  const result = await run([{ op: 'modify', id: `e${line}`, set: { ...noSet, end: [1234, 5678] } },
    { op: 'modify', id: `e${moji}`, set: { ...noSet, text: '洋室 8帖' } },
    { op: 'modify', id: `e${arc}`, set: { ...noSet, radius: 400 } }]);
  const l = result.after.entities[line].props, m = result.after.entities[moji].props, a = result.after.entities[arc].props;
  approx(l.m_end_x, 1234 / scale); approx(l.m_end_y, 5678 / scale); assert.equal(l.m_start_x, document.entities[line].props.m_start_x);
  assert.equal(m.m_string, '洋室 8帖'); inRange(m.m_end_x - m.m_start_x, '洋室 8帖', m.m_dSizeX, m.m_dKankaku);
  approx(a.m_dHankei, 400 / scaleOf(document, a));
});

test('native: add line, point, arc and circle with defaults and pen', opts, async () => {
  const { document } = await load(), n = document.entities.length, scale = scaleOf(document, { m_nGLayer: 0, m_nLayer: 3 });
  const result = await run([
    { op: 'add', tempId: 'n0', entity: { kind: 'line', layer: '0:3', start: [0, 0], end: [1820, 910], pen: { color: 3, style: null, width: null } } },
    { op: 'add', tempId: 'n1', entity: { kind: 'point', layer: '0:3', at: [455, 455], pen: noPen } },
    { op: 'add', tempId: 'n2', entity: { kind: 'arc', layer: '0:3', center: [1000, 1000], radius: 300, startAngle: 0, sweepAngle: 90, flatness: null, tilt: null, pen: noPen } },
    { op: 'add', tempId: 'n3', entity: { kind: 'arc', layer: '0:3', center: [2000, 1000], radius: 450, startAngle: 0, sweepAngle: 360, flatness: null, tilt: null, pen: noPen } }]);
  assert.deepEqual(result.receipt.created, { n0: `e${n}`, n1: `e${n + 1}`, n2: `e${n + 2}`, n3: `e${n + 3}` });
  const [line, point, arc, circle] = result.after.entities.slice(n);
  assert.deepEqual([line.type, point.type, arc.type, circle.type], ['JwwSen', 'JwwTen', 'JwwEnko', 'JwwEnko']);
  approx(line.props.m_end_x, 1820 / scale); approx(line.props.m_end_y, 910 / scale); assert.deepEqual([line.props.m_nPenColor, line.props.m_nPenStyle, line.props.m_nLayer], [3, 1, 3]);
  approx(point.props.m_start_x, 455 / scale);
  approx(arc.props.m_dHankei, 300 / scale); approx(arc.props.m_radEnkoKaku, Math.PI / 2); assert.equal(arc.props.m_bZenEnFlg, 0);
  assert.equal(circle.props.m_bZenEnFlg, 1); approx(circle.props.m_radEnkoKaku, 2 * Math.PI);
  assert.equal(result.ir.entities.length, n + 4);
});

test('native: add Japanese text 洋室 6帖 using the 文字種 table', opts, async () => {
  const { document } = await load(), n = document.entities.length, scale = scaleOf(document, { m_nGLayer: 0, m_nLayer: 4 });
  const result = await run([{ op: 'add', tempId: 'n0', entity: textOf([3640, 1820], '洋室 6帖', { style: 6 }) }]);
  const t = result.after.entities[n].props;
  assert.equal(t.m_string, '洋室 6帖'); assert.deepEqual([t.m_dSizeX, t.m_dSizeY, t.m_dKankaku, t.m_nMojiShu, t.m_nPenColor, t.m_nLayer], [6, 6, 1, 6, 3, 4]);
  approx(t.m_start_x, 3640 / scale); approx(t.m_start_y, 1820 / scale); inRange(t.m_end_x - t.m_start_x, '洋室 6帖', 6, 1); assert.equal(t.m_end_y, t.m_start_y);
  assert.equal(t.m_strFontName, document.entities[firstOf(document, 'JwwMoji')].props.m_strFontName);
});

test('native: setLayer across scale groups keeps model position; setPen changes only the pen', opts, async () => {
  const { document, ir } = await load(), i = firstOf(document, 'JwwSen', [0]);
  const layer = ir.layers.find(l => l.scale !== ir.layers.find(x => x.id === ir.entities[i].layerId).scale)?.id ?? ir.entities[i].layerId;
  const result = await run([{ op: 'setLayer', ids: [`e${i}`], layer }, { op: 'setPen', ids: [`e${i}`], pen: { color: 4, style: 2, width: null } }]);
  const got = result.ir.entities[i], p = result.after.entities[i].props;
  assert.equal(got.layerId, layer);
  ir.entities[i].points.forEach((v, k) => approx(got.points[k], v, 'model position'));
  assert.deepEqual([p.m_nPenColor, p.m_nPenStyle, p.m_nPenWidth], [4, 2, document.entities[i].props.m_nPenWidth]);
});

test('native: tempId add then translate in one patch', opts, async () => {
  const { document } = await load(), n = document.entities.length, scale = scaleOf(document, { m_nGLayer: 0, m_nLayer: 1 });
  const result = await run([
    { op: 'add', tempId: 'n0', entity: { kind: 'line', layer: '0:1', start: [0, 0], end: [910, 0], pen: noPen } },
    { op: 'translate', ids: ['n0'], dx: 100, dy: 200 }]);
  const p = result.after.entities[n].props;
  approx(p.m_start_x, 100 / scale); approx(p.m_start_y, 200 / scale); approx(p.m_end_x, 1010 / scale); approx(p.m_end_y, 200 / scale);
  assert.equal(result.receipt.created.n0, `e${n}`);
});

test('native: DLL writer fallback applies translate, delete and Japanese text and passes the same verification', opts, async () => {
  const { document } = await load(), i = firstOf(document, 'JwwSen'), n = document.entities.length;
  const result = await run([{ op: 'translate', ids: [`e${i}`], dx: 455, dy: 0 }, { op: 'delete', ids: ['e5'] }, { op: 'add', tempId: 'n0', entity: textOf([0, 0], '洋室 6帖', { style: 6 }) }], 'dll');
  assert.equal(result.receipt.writer, 'dll'); assert.equal(result.receipt.verified, true); assert.equal(result.receipt.byteExactOutsideEdits, null);
  assert.equal(result.after.entities.length, n); assert.equal(result.after.entities[n - 1].props.m_string, '洋室 6帖');
});

test('native: stale hash, unknown targets and unsafe text are rejected before any write', opts, async () => {
  const { bytes, document, ir } = await load();
  await assert.rejects(applyPatchV2(bytes, { ...patchFor(bytes, [{ op: 'delete', ids: ['e0'] }]), sourceHash: 'x'.repeat(64) }, { ir, document }), code('E_PATCH_STALE'));
  await assert.rejects(applyPatchV2(bytes, patchFor(bytes, [{ op: 'delete', ids: ['e999999'] }]), { ir, document }), code('E_PATCH_ENTITY'));
  await assert.rejects(applyPatchV2(Buffer.concat([bytes, Buffer.from([0])]), patchFor(bytes, [{ op: 'delete', ids: ['e0'] }]), { ir, document }), code('E_PATCH_STALE'));
  await assert.rejects(run([{ op: 'add', tempId: null, entity: textOf([0, 0], 'smile 😀') }]), code('E_JWW_TEXT_CHAR'));
});

test('native blocks: translating a block and adding text keeps definitions, children and strings',
  { skip: !process.env.FRESCO_JWW_BLOCK_FIXTURE, timeout: 600000 }, async () => {
    const bytes = await readFile(process.env.FRESCO_JWW_BLOCK_FIXTURE), document = await readJww(bytes), ir = toIR(bytes, document);
    const probe = await probeRewriteSafety(bytes, { document });
    assert.equal(probe.byteExact, true); assert.equal(probe.safe, true);
    const i = firstOf(document, 'JwwBlock'), scale = scaleOf(document, document.entities[i].props);
    const result = await applyPatchV2(bytes, patchFor(bytes, [{ op: 'translate', ids: [`e${i}`], dx: 1000, dy: 0 }, { op: 'add', tempId: null, entity: textOf([0, 0], '洋室 6帖', { layer: '0:0' }) }]), { ir, document });
    const after = await readJww(result.bytes);
    assert.equal(after.blocks.length, document.blocks.length);
    for (const [k, b] of document.blocks.entries()) assert.deepEqual(after.blocks[k], b);
    approx(after.entities[i].props.m_DPKijunTen_x, document.entities[i].props.m_DPKijunTen_x + 1000 / scale);
    assert.equal(after.entities.length, document.entities.length + 1);
    assert.equal(result.receipt.writer, 'codec'); assert.equal(result.receipt.byteExactOutsideEdits, true);
  });
