import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Reader, Writer, encodeCString, encodeCp932, decodeCp932 } from '../native/codec/archive.mjs';
import { decodeJww, encodeJww, createJww, semanticView, JwwEntity, RAW, SPAN } from '../native/codec/jww-codec.mjs';
import { applyOps, cloneDoc, textLength } from '../native/codec/jww-ops.mjs';
import { compareWithNative } from '../native/codec/compare.mjs';
import { validatePatchV2 } from '../core/patch-v2.mjs';

const hexOf = b => Buffer.from(b).toString('hex');
const base = { m_lGroup: 0, m_nPenStyle: 1, m_nPenColor: 1, m_nPenWidth: 0, m_nLayer: 0, m_nGLayer: 0, m_sFlg: 0 };
const sen = (x = 0) => ({ ...base, m_start_x: x, m_start_y: 0, m_end_x: x + 1, m_end_y: 2 });
const moji = text => ({ ...base, m_start_x: 1, m_start_y: 2, m_end_x: 3, m_end_y: 2, m_nMojiShu: 0, m_dSizeX: 2.5, m_dSizeY: 2.5, m_dKankaku: 0, m_degKakudo: 0, m_strFontName: 'ＭＳ ゴシック', m_string: text });
const ten = style => ({ ...base, m_nPenStyle: style, m_start_x: 5, m_start_y: 6, m_bKariten: 0, ...(style === 100 ? { m_nCode: 3, m_radKaitenKaku: 0.5, m_dBairitsu: 2 } : {}) });

test('CString: ANSI, long, Unicode and canonical length prefixes', () => {
  assert.equal(hexOf(encodeCString('AB')), '024142');
  assert.equal(hexOf(encodeCString('あ')), '0282a0');
  const long = encodeCString('x'.repeat(300));
  assert.equal(hexOf(long.subarray(0, 3)), 'ff2c01');
  assert.equal(hexOf(encodeCString('㎆')), 'fffeff018633');
  assert.equal(hexOf(encodeCString('A', { unicode: true })), 'fffeff014100');
  const bytes = Buffer.concat([encodeCString('漢字'), long, encodeCString('㎆'), Buffer.from('fffeffff0001' + '4100'.repeat(256), 'hex'), Buffer.from('ff03004142434d', 'hex')]);
  const r = new Reader(bytes), at = 5 + long.length;
  assert.deepEqual([r.cstring().text, r.cstring().text.length, r.cstring()], ['漢字', 300, { text: '㎆', raw: bytes.subarray(at, at + 6), unicode: true }]);
  const wide = r.cstring(); assert.equal(wide.text, 'A'.repeat(256)); assert.equal(wide.unicode, true);
  const loose = r.cstring(); // non-canonical FF+WORD prefix for a short string keeps its raw bytes
  assert.equal(loose.text, 'ABC'); assert.equal(hexOf(loose.raw), 'ff0300414243');
  assert.equal(r.u8(), 0x4d);
});

test('CP932 table follows Windows best-fit choices for duplicated code points', () => {
  assert.equal(hexOf(encodeCp932('纊')), 'fa5c');
  assert.equal(hexOf(encodeCp932('∵')), '81e6');
  assert.equal(hexOf(encodeCp932('￢')), '81ca'); // not EEF9/FA54
  assert.equal(encodeCp932('¬'), null);
  assert.equal(hexOf(encodeCp932('①ｱ')), '8740b1');
  assert.equal(encodeCp932('㎆'), null);
  assert.equal(encodeCp932('¥'), null);
  assert.equal(decodeCp932(Buffer.from('82a0fa5c', 'hex')), 'あ纊');
});

test('CArchive tags: new class, old class, big PID escape, object refs, counts', () => {
  const w = new Writer(4);
  assert.equal(w.beginObject('CDataSen', 600), 2);
  assert.equal(w.beginObject('CDataSen', 600), 3);
  assert.equal(w.beginObject('CDataMoji', 600), 5);
  w.nextPid = 0x8000; w.classes.set('CDataTen', { pid: 0x7fff, schema: 600 });
  w.beginObject('CDataTen', 600);
  w.pidTag(0x7ffe, false); w.pidTag(0x9000, false); w.u16(0);
  w.count(3); w.count(0x12345);
  const bytes = w.result();
  assert.equal(hexOf(bytes.subarray(0, 14)), 'ffff58020800' + Buffer.from('CDataSen').toString('hex'));
  assert.equal(hexOf(bytes.subarray(14, 16)), '0180');
  const r = new Reader(bytes);
  const first = r.tag(); r.registerObject('CDataSen');
  assert.deepEqual([first.kind, first.pid, first.name, first.schema], ['new', 1, 'CDataSen', 600]);
  const second = r.tag(); r.registerObject('CDataSen');
  assert.deepEqual([second.kind, second.pid, second.name], ['class', 1, 'CDataSen']);
  assert.equal(r.tag().pid, 4); r.registerObject('CDataMoji');
  while (r.pids.length < 0x8000) r.pids.push({ kind: 'object' });
  r.pids[0x7fff] = { kind: 'class', name: 'CDataTen', schema: 600 };
  const big = r.tag();
  assert.deepEqual([big.kind, big.pid, big.big, hexOf(big.tagBytes)], ['class', 0x7fff, true, 'ff7fff7f0080']);
  const ref = r.tag();
  assert.deepEqual([ref.kind, ref.pid], ['object', 0x7ffe]);
  assert.throws(() => r.tag(), { code: 'E_JWW_TAG' }); // 0x9000 was never registered
  r.o = bytes.length - 10;
  assert.equal(r.tag().kind, 'null');
  assert.deepEqual([r.count(), r.count()], [3, 0x12345]);
});

test('synthetic v700 document: every class, Unicode strings, images, blocks round-trip byte-exactly', () => {
  const doc = createJww({ version: 700 });
  doc.header.m_aStrLayName[0][1] = '壁'; doc.header.m_adScale[1] = 50;
  const sunpou = { ...base, m_Sen: sen(), m_Moji: moji('1,000'), m_bSxfMode: 0, m_SenHo1: sen(1), m_SenHo2: sen(2), m_Ten1: ten(1), m_Ten2: ten(100), m_TenHo1: ten(1), m_TenHo2: ten(1) };
  doc.entities.push(new JwwEntity('e0', 'CDataSen', sen()), new JwwEntity('e1', 'CDataMoji', moji('㎆ unicode')), new JwwEntity('e2', 'CDataTen', ten(100)),
    new JwwEntity('e3', 'CDataSunpou', sunpou), new JwwEntity('e4', 'CDataSolid', { ...sen(), m_nPenColor: 10, m_DPoint2_x: 1, m_DPoint2_y: 1, m_DPoint3_x: 0, m_DPoint3_y: 1, m_Color: 0xeeeeee }),
    new JwwEntity('e5', 'CDataEnko', { ...base, m_start_x: 0, m_start_y: 0, m_dHankei: 3, m_radKaishiKaku: 0, m_radEnkoKaku: Math.PI, m_radKatamukiKaku: 0, m_dHenpeiRitsu: 1, m_bZenEnFlg: 0 }),
    new JwwEntity('e6', 'CDataBlock', { ...base, m_DPKijunTen_x: 1, m_DPKijunTen_y: 1, m_dBairitsuX: 1, m_dBairitsuY: 1, m_radKaitenKaku: 0, m_nNumber: 7 }));
  doc.blocks.push(new JwwEntity('b0', 'CDataList', { ...base, m_nNumber: 7, m_bReffered: 1, m_time: 1700000000, m_strName: 'ブロック' }, [new JwwEntity('b0/e0', 'CDataSen', sen(9))]));
  doc.images.push({ name: '%temp%/a.bmp.gz', data: Buffer.from([1, 2, 3, 4]) });
  const bytes = encodeJww(doc), back = decodeJww(bytes);
  assert.deepEqual(back.diagnostics, []);
  assert.deepEqual(encodeJww(back), bytes);
  assert.deepEqual(back.entities.map(e => e.kind), ['line', 'text', 'point', 'dimension', 'solid', 'arc', 'block']);
  assert.equal(back.entities[1].props[RAW].get('m_string').unicode, true);
  assert.equal(back.entities[3].props.m_Ten2.m_nCode, 3);
  assert.equal(back.entities[4].props.m_Color, 0xeeeeee);
  assert.deepEqual(semanticView(back).blocks[0], { id: 'b0', kind: 'blockDefinition', type: 'JwwDataList', layer: '0:0', pen: { style: 1, color: 1, width: 0 }, geometry: null, number: 7, name: 'ブロック',
    children: [{ id: 'b0/e0', kind: 'line', type: 'JwwSen', layer: '0:0', pen: { style: 1, color: 1, width: 0 }, geometry: { start: [9, 0], end: [10, 2] } }] });
  assert.deepEqual(semanticView(back).images, [{ name: '%temp%/a.bmp.gz', size: 4 }]);
  assert.equal(semanticView(back).layers[1].name, '壁');
  // Class order: first use defines the class, later uses reference its PID.
  assert.deepEqual(back.entities.map(e => e[SPAN][2]), ['new', 'new', 'new', 'new', 'new', 'new', 'new']);
});

test('pre-4.20 layout omits SXF dimension parts; NaN payloads survive', () => {
  const doc = createJww({ version: 351 });
  doc.entities.push(new JwwEntity('e0', 'CDataSunpou', { ...base, m_Sen: sen(), m_Moji: moji('x') }), new JwwEntity('e1', 'CDataSen', sen()));
  const bytes = encodeJww(doc);
  assert.equal(decodeJww(bytes).images, null);
  const offset = bytes.length - 2 - 8 * 4; // last line's first coordinate, before the empty block-list count
  const tampered = Buffer.from(bytes); tampered.writeUInt32LE(0x00000001, offset); tampered.writeUInt32LE(0x7ff40000, offset + 4); // signalling NaN payload
  const nan = decodeJww(tampered);
  assert.ok(Number.isNaN(nan.entities[1].props.m_start_x));
  assert.deepEqual(encodeJww(nan), tampered);
  assert.deepEqual(nan.diagnostics.map(d => d.code), ['NAN_FIELD']);
});

test('big PID escape: more than 0x7FFE objects re-encode byte-exactly', () => {
  const doc = createJww({ version: 600 });
  for (let i = 0; i < 0x8010; i++) doc.entities.push(new JwwEntity(`e${i}`, i === 0x8005 ? 'CDataMoji' : 'CDataSen', i === 0x8005 ? moji('late class') : sen(i)));
  doc.entities.push(new JwwEntity('x', 'CDataMoji', moji('big class ref')));
  const bytes = encodeJww(doc), back = decodeJww(bytes);
  assert.deepEqual(encodeJww(back), bytes);
  assert.equal(back.entities.at(-1).props.m_string, 'big class ref');
  assert.equal(hexOf(bytes.subarray(back.entities.at(-1)[SPAN][0], back.entities.at(-1)[SPAN][0] + 6)), 'ff7f' + (0x80000000 + 0x8007).toString(16).match(/../g).reverse().join(''));
});

test('applyOps on a synthetic document: model mm, CP932 strings, class definition hand-over', () => {
  const doc = createJww({ version: 600 });
  doc.header.m_adScale[0] = 100;
  doc.entities.push(new JwwEntity('e0', 'CDataSen', sen(1)), new JwwEntity('e1', 'CDataSen', sen(2)), new JwwEntity('e2', 'CDataMoji', moji('旧')));
  const source = decodeJww(encodeJww(doc));
  const { doc: next, idMap } = applyOps(source, [
    { op: 'delete', ids: ['e0'] },
    { op: 'translate', ids: ['e1'], dx: 100, dy: -200 },
    { op: 'modify', id: 'e2', set: { text: '新しい文字A', angle: 90 } },
    { op: 'add', tempId: 'n0', entity: { kind: 'arc', layer: '0:3', center: [1000, 0], radius: 500, startAngle: 90, sweepAngle: -180, pen: {} } },
    { op: 'add', entity: { kind: 'text', layer: '0:0', at: [0, 0], text: 'ｱｲ', style: 3 } },
    { op: 'setPen', ids: ['n0'], pen: { color: 3 } }
  ]);
  assert.equal(source.entities.length, 3, 'source untouched');
  const bytes = encodeJww(next), back = decodeJww(bytes);
  assert.deepEqual(encodeJww(back), bytes);
  assert.deepEqual(back.entities.map(e => e[SPAN][2]), ['new', 'new', 'new', 'class']); // e1 now defines CDataSen
  const [line, text, arc, added] = back.entities.map(e => e.props);
  assert.deepEqual([line.m_start_x, line.m_start_y, line.m_end_x], [3, -2, 4]);
  assert.equal(text.m_string, '新しい文字A');
  assert.equal(hexOf(back.entities[1].props[RAW].get('m_string').raw), '0b' + hexOf(encodeCp932('新しい文字A')));
  assert.ok(Math.abs(text.m_end_x - 1) < 1e-12 && Math.abs(text.m_end_y - 2 - textLength('新しい文字A', 2.5, 0)) < 1e-12);
  assert.deepEqual([arc.m_start_x, arc.m_dHankei, arc.m_nGLayer, arc.m_nLayer, arc.m_nPenColor], [10, 5, 0, 3, 3]);
  assert.ok(Math.abs(arc.m_radKaishiKaku - 3 * Math.PI / 2) < 1e-12 && Math.abs(arc.m_radEnkoKaku - Math.PI) < 1e-12);
  assert.equal(idMap.n0, 'n0');
  assert.equal(added.m_string, 'ｱｲ');
  assert.throws(() => applyOps(source, [{ op: 'translate', ids: ['nope'], dx: 1, dy: 0 }]), { code: 'E_CODEC_ENTITY' });
  assert.throws(() => applyOps(source, [{ op: 'modify', id: 'e0', set: { text: 'x' } }]), { code: 'E_CODEC_MODIFY_FIELD' });
  assert.throws(() => applyOps(source, [{ op: 'setPen', ids: ['e2'], pen: { style: 2 } }]), { code: 'E_CODEC_PEN' });
});

// Corpus: set FRESCO_JWW_CORPUS=C:/JWW. Files are only read.
const corpus = process.env.FRESCO_JWW_CORPUS;
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full)); else if (/\.jww$/iu.test(entry.name)) out.push(full);
  }
  return out.sort();
}

test('corpus: decode -> encode is byte-identical for every .jww', { skip: !corpus, timeout: 120000 }, async () => {
  const files = await walk(corpus);
  assert.ok(files.length > 0);
  for (const file of files) {
    const bytes = await readFile(file), doc = decodeJww(bytes);
    assert.equal(doc.partial, undefined, file);
    assert.ok(encodeJww(doc).equals(bytes), `${file} not byte-exact`);
    assert.ok(encodeJww(cloneDoc(doc)).equals(bytes), `${file} clone not byte-exact`);
  }
});

test('corpus: semantic view matches the native JwwHelper reader', { skip: !corpus, timeout: 600000 }, async () => {
  const { readJww } = await import('../native/jww.mjs');
  for (const file of await walk(corpus)) {
    const bytes = await readFile(file), result = compareWithNative(decodeJww(bytes), await readJww(bytes));
    assert.ok(result.ok, `${file}: ${JSON.stringify(result.mismatches)}`);
    assert.ok(result.notes.every(n => n.code === 'NATIVE_LOSSY_STRING'), file);
  }
});

const fixtures = [process.env.FRESCO_JWW_FIXTURE, process.env.FRESCO_JWW_BLOCK_FIXTURE].filter(Boolean);
test('corpus mutations: Patch v2 ops survive re-decode and the native reader; untouched bytes stay identical', { skip: !fixtures.length, timeout: 300000 }, async () => {
  const { readJww, hash } = await import('../native/jww.mjs');
  for (const file of fixtures) {
    const bytes = await readFile(file), doc = decodeJww(bytes), view = semanticView(doc);
    const ir = { sourceHash: hash(bytes), entities: view.entities, layers: view.layers };
    const firstOf = kind => doc.entities.find(e => e.kind === kind && e[SPAN][2] === 'class');
    const line = firstOf('line'), text = firstOf('text'), victim = doc.entities.find(e => e !== line && e !== text && e[SPAN][2] === 'class');
    const layer = line.layer, scale = doc.header.m_adScale[line.props.m_nGLayer];

    // Translate only: exactly the 32 coordinate bytes change.
    const moved = encodeJww(applyOps(doc, validatePatchV2({ schemaVersion: 2, sourceHash: ir.sourceHash, units: 'model-mm', rationale: 't', needsClarification: null,
      ops: [{ op: 'translate', ids: [line.id], dx: 910, dy: 0 }] }, ir).ops).doc);
    const coords = line[SPAN][1] - 32;
    assert.equal(moved.length, bytes.length);
    assert.ok(moved.subarray(0, coords).equals(bytes.subarray(0, coords)) && moved.subarray(coords + 32).equals(bytes.subarray(coords + 32)), file);
    assert.ok(Math.abs(moved.readDoubleLE(coords) - line.props.m_start_x - 910 / scale) < 1e-9);

    // Delete only: output = source minus the record, except the list count and renumbered class-reference tags of later records.
    const deleted = encodeJww(applyOps(doc, [{ op: 'delete', ids: [victim.id] }]).doc);
    const [s, e] = victim[SPAN], expected = Buffer.concat([bytes.subarray(0, s), bytes.subarray(e)]);
    assert.equal(deleted.length, expected.length);
    const tagOffsets = new Set([doc.spans.entities[0], doc.spans.entities[0] + 1]); // entity count WORD
    const collect = list => { for (const item of list) { if (item[SPAN][0] > s) tagOffsets.add(item[SPAN][0] - (e - s)), tagOffsets.add(item[SPAN][0] - (e - s) + 1); if (item.children) collect(item.children); } };
    collect(doc.entities); collect(doc.blocks);
    for (let i = 0; i < expected.length; i++) if (deleted[i] !== expected[i]) assert.ok(tagOffsets.has(i), `${file}: unexpected byte change at ${i}`);

    const ops = validatePatchV2({ schemaVersion: 2, sourceHash: ir.sourceHash, units: 'model-mm', rationale: 'all ops', needsClarification: null, ops: [
      { op: 'translate', ids: [line.id], dx: 1000, dy: -500 },
      ...(text ? [{ op: 'modify', id: text.id, set: { start: null, end: null, at: [100, 200], center: null, radius: null, startAngle: null, sweepAngle: null, text: '変更 ABC', height: 5, width: 4, angle: 30 } }] : []),
      { op: 'delete', ids: [victim.id] },
      { op: 'add', tempId: 'n1', entity: { kind: 'line', layer, start: [0, 0], end: [3000, 4000], pen: { color: 2, style: 1, width: null } } },
      { op: 'add', tempId: 'n2', entity: { kind: 'text', layer, at: [100, 200], text: '追加文字', height: null, width: null, spacing: null, angle: null, style: 3, color: null } },
      { op: 'add', tempId: 'n3', entity: { kind: 'arc', layer, center: [500, 500], radius: 250, startAngle: 0, sweepAngle: 360, flatness: null, tilt: null, pen: null } },
      { op: 'add', tempId: 'n4', entity: { kind: 'point', layer, at: [10, 20], pen: null } },
      { op: 'setLayer', ids: ['n1'], layer: '1:2' },
      { op: 'setPen', ids: [line.id], pen: { color: 6, style: 2, width: null } }
    ] }, ir).ops;
    const { doc: next } = applyOps(doc, ops), out = encodeJww(next), back = decodeJww(out);
    assert.ok(encodeJww(back).equals(out));
    assert.equal(back.entities.length, doc.entities.length + 3);
    const native = await readJww(out), cmp = compareWithNative(back, native);
    assert.ok(cmp.ok, `${file}: ${JSON.stringify(cmp.mismatches)}`);
    const nLine = native.entities[doc.entities.indexOf(line) - (doc.entities.indexOf(victim) < doc.entities.indexOf(line) ? 1 : 0)].props;
    assert.ok(Math.abs(nLine.m_start_x - line.props.m_start_x - 1000 / scale) < 1e-9);
    assert.deepEqual([nLine.m_nPenColor, nLine.m_nPenStyle], [6, 2]);
    const tail = native.entities.slice(-4);
    assert.deepEqual(tail.map(e => e.type), ['JwwSen', 'JwwMoji', 'JwwEnko', 'JwwTen']);
    const scale12 = doc.header.m_adScale[1];
    assert.deepEqual([tail[0].props.m_nGLayer, tail[0].props.m_nLayer], [1, 2]);
    assert.ok(Math.abs(tail[0].props.m_end_x * scale12 - 3000) < 1e-6);
    assert.equal(tail[1].props.m_string, '追加文字');
    assert.equal(tail[2].props.m_bZenEnFlg, 1);
    if (text) assert.equal(native.entities.find(n => n.props.m_string === '変更 ABC')?.props.m_degKakudo, 30);
  }
});

test('native reader accepts codec-built files: big PID tags, block list, class-definition hand-over', { skip: !fixtures.length, timeout: 300000 }, async () => {
  const { readJww } = await import('../native/jww.mjs');
  const doc = createJww({ version: 700 });
  for (let i = 0; i < 0x8010; i++) doc.entities.push(new JwwEntity(`e${i}`, i === 0x8005 ? 'CDataMoji' : 'CDataSen', i === 0x8005 ? moji('late') : sen(i)));
  doc.entities.push(new JwwEntity('x', 'CDataMoji', moji('big ref')));
  doc.blocks.push(new JwwEntity('b0', 'CDataList', { ...base, m_nNumber: 0, m_bReffered: 0, m_time: 0, m_strName: 'blk' }, [new JwwEntity('b0/e0', 'CDataSen', sen())]));
  const bytes = encodeJww(doc), result = compareWithNative(decodeJww(bytes), await readJww(bytes));
  assert.ok(result.ok, JSON.stringify(result.mismatches));
  const source = decodeJww(await readFile(fixtures[0])), first = source.entities[0];
  assert.equal(first[SPAN][2], 'new');
  const out = encodeJww(applyOps(source, [{ op: 'delete', ids: [first.id] }]).doc), native = await readJww(out);
  assert.equal(native.entities.length, source.entities.length - 1);
  assert.ok(compareWithNative(decodeJww(out), native).ok);
});
