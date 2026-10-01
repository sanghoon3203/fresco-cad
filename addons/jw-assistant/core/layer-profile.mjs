// Office layer convention profile: observe drawings, aggregate a profile, check drawings and AI patches against it.
// Pure module: no filesystem, network or native imports; callers read files and supply hashes. See docs/jw-assistant/layer-check.md.
// Units: line lengths and text heights are paper mm (scale independent); bounding boxes are model mm. Stable codes: E_LAYER_PROFILE_*.
import { buildStructure, transformPoint } from '../native/jww-structure.mjs';

export const LAYER_PROFILE_SCHEMA = 1;
const fail = (code, detail) => { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, detail }); };
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const sum = list => list.reduce((a, b) => a + b, 0);
const inc = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };
const natural = (a, b) => {
  const A = String(a).split(/(\d+)/u), B = String(b).split(/(\d+)/u);
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    if (A[i] === B[i]) continue;
    return i % 2 ? Number(A[i]) - Number(B[i]) || cmp(A[i], B[i]) : cmp(A[i], B[i]);
  }
  return A.length - B.length;
};
const norm = s => String(s ?? '').normalize('NFKC').replace(/[\s　]+/gu, '').toLowerCase();
const trunc = (s, n) => { const a = Array.from(String(s)); return a.length > n ? `${a.slice(0, n).join('')}…` : a.join(''); };
const sortedHist = h => Object.fromEntries(Object.entries(h).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]) || cmp(a[0], b[0])));
const capHist = (h, max = 32) => {
  const e = Object.entries(h); if (e.length <= max) return h;
  const top = e.sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, max - 1);
  return { ...Object.fromEntries(top), '*': sum(e.slice(max - 1).map(x => x[1])) };
};

export const KINDS = Object.freeze(['line', 'arc', 'point', 'text', 'dim', 'solid', 'block', 'other']);
const KIND_OF = { JwwSen: 'line', JwwEnko: 'arc', JwwTen: 'point', JwwMoji: 'text', JwwSunpou: 'dim', JwwSolid: 'solid', JwwBlock: 'block' };
// Jw_cad pen styles 1-7 are the documented line types; 8/9 are kept numeric (names unverified).
export const LINE_TYPES = Object.freeze({ 1: ['実線', '실선'], 2: ['点線1', '점선1'], 3: ['点線2', '점선2'], 4: ['一点鎖線1', '일점쇄선1'],
  5: ['一点鎖線2', '일점쇄선2'], 6: ['二点鎖線1', '이점쇄선1'], 7: ['二点鎖線2', '이점쇄선2'], 8: ['線種8', '선종8'], 9: ['線種9', '선종9'] });
const CHAIN = [4, 5], GRID_MIN = 15, LONG = 15;
const styleName = (s, i) => LINE_TYPES[s]?.[i] ?? String(s);

// ---- semantic roles. `primary` kinds are what the layer is for; `forbidden` kinds never belong there.
export const ROLES = Object.freeze({
  grid: { ja: '通り芯', ko: '통심(通り芯)', names: ['通り芯', '通芯', '通心', '通り心', '芯', 'グリッド', 'grid', '基準線'], primary: ['line', 'arc', 'text', 'point'], forbidden: ['dim', 'solid', 'block'] },
  wall: { ja: '壁', ko: '벽', names: ['壁', '躯体', '間仕切', 'ブロック', 'wall'], primary: ['line', 'arc', 'solid', 'block', 'point'], forbidden: ['text', 'dim'] },
  structure: { ja: '柱・梁・基礎', ko: '구조(기둥·보·기초)', names: ['柱', '梁', '基礎', 'スラブ', '床組', '桁', '土台', '構造', '胴差', '筋かい', '筋違'], primary: ['line', 'arc', 'solid', 'block', 'point'], forbidden: ['text', 'dim'] },
  opening: { ja: '建具', ko: '창호', names: ['建具', '窓', 'サッシ', 'ドア', '扉', '開口', 'door', 'window', 'sash'], primary: ['line', 'arc', 'block', 'solid', 'point'], forbidden: ['text', 'dim'] },
  finish: { ja: '仕上', ko: '마감', names: ['仕上', '天井', '床材', '巾木', 'タイル', 'ボード', 'finish'], primary: ['line', 'arc', 'solid', 'block', 'point'], forbidden: ['dim'] },
  stair: { ja: '階段', ko: '계단', names: ['階段', 'stair'], primary: ['line', 'arc', 'solid', 'block', 'point'], forbidden: ['dim'] },
  roof: { ja: '屋根・庇', ko: '지붕·처마', names: ['屋根', '庇', '軒', 'roof'], primary: ['line', 'arc', 'solid', 'block', 'point'], forbidden: ['dim'] },
  dimension: { ja: '寸法', ko: '치수', names: ['寸法', 'dim', 'サンポウ'], primary: ['dim', 'line', 'text', 'point', 'arc'], forbidden: ['block', 'solid'] },
  text: { ja: '文字・室名', ko: '문자·실명', names: ['室名', '文字', '注記', 'テキスト', 'text', 'コメント', '部屋名'], primary: ['text'], forbidden: ['dim', 'block'] },
  equipment: { ja: '設備', ko: '설비', names: ['設備', '機器', '衛生', '器具', '電気', '照明', '給排水', '空調', '換気', 'ダクト', '配管', 'エレベ', 'elevator', 'キッチン', 'ユニットバス', '便器'], primary: ['block', 'line', 'arc', 'solid', 'point'], forbidden: ['dim'] },
  furniture: { ja: '家具', ko: '가구', names: ['家具', 'ファニチャ', 'furniture', '什器'], primary: ['block', 'line', 'arc', 'solid', 'point'], forbidden: ['dim'] },
  site: { ja: '敷地・外構', ko: '부지·외구', names: ['敷地', '外構', '擁壁', '道路', '隣地', '境界', '植栽', '芝', '駐車', '造成', '等高線', '塀', 'site'], primary: ['line', 'arc', 'text', 'point', 'solid'], forbidden: ['block'] },
  auxiliary: { ja: '補助線', ko: '보조선', names: ['補助', '下書', 'ガイド', 'guide', 'aux', '作図'], primary: ['line', 'arc', 'point'], forbidden: ['dim', 'solid', 'block'] },
  frame: { ja: '図枠・表題', ko: '도면틀·표제', names: ['図枠', '表題', 'タイトル', '図名', 'title', 'frame', '凡例', '方位'], primary: ['line', 'text', 'solid', 'arc', 'block'], forbidden: ['dim'] },
  hatch: { ja: 'ハッチ・色塗', ko: '해치·채움', names: ['ハッチ', '色塗', '塗潰', '塗り潰', 'hatch', 'ベタ'], primary: ['solid', 'line'], forbidden: ['text', 'dim'] },
  elevation: { ja: '立面・見付', ko: '입면·견부', names: ['立面', '見付', '展開', '透視', '鳥瞰', 'アイソメ', '東面', '西面', '南面', '北面'], primary: ['line', 'arc', 'solid', 'block', 'point', 'text'], forbidden: ['dim'] },
  unknown: { ja: '未分類', ko: '미분류', names: [], primary: KINDS, forbidden: [] }
});
// First keyword hit wins, so specific roles precede generic ones (仕上 before 壁, 擁壁 -> site before 壁).
export const ROLE_ORDER = Object.freeze(['frame', 'grid', 'dimension', 'text', 'opening', 'finish', 'stair', 'site', 'roof', 'equipment', 'furniture', 'hatch', 'auxiliary', 'structure', 'wall', 'elevation']);
const roleName = (role, lang) => ROLES[role]?.[lang] ?? role;
const COMPATIBLE = new Set(['text|dimension', 'text|frame', 'text|site', 'text|equipment', 'hatch|finish', 'hatch|wall', 'hatch|structure']);

const DEFAULT_LAYER = /^\d+-\d+レイヤ$/u, DEFAULT_GROUP = /^\d+グループ$/u;
const ROOM = /洋室|和室|リビング|ldk|dk|ダイニング|キッチン|浴室|脱衣|洗面|トイレ|便所|玄関|廊下|収納|押入|クローゼット|寝室|子供室|書斎|ホール|ベランダ|バルコニー|納戸|物入|下駄箱|wic|機械室|倉庫|事務室|会議室|階段室|ev/u;

/** Role from layer/group name only. Returns null when the name carries no keyword. */
export function roleFromName(name, groupName = '') {
  const n = norm(name).replace(/インドア|アウトドア/gu, ''), g = norm(groupName);
  const named = n && !DEFAULT_LAYER.test(n);
  if (named) for (const role of ROLE_ORDER) {
    const hit = ROLES[role].names.find(k => n.includes(k));
    if (hit) return { role, confidence: hit.length >= 2 ? 0.9 : 0.8, evidence: [`layer name "${trunc(String(name).trim(), 20)}" contains ${hit}`] };
  }
  // A group name is weaker evidence and only helps for unnamed layers of specific groups.
  if (!named && g && !DEFAULT_GROUP.test(g)) for (const role of ROLE_ORDER) {
    if (role === 'site' || role === 'wall' || role === 'elevation') continue;
    const hit = ROLES[role].names.find(k => g.includes(k));
    if (hit) return { role, confidence: 0.45, evidence: [`group name "${trunc(String(groupName).trim(), 20)}" contains ${hit}`] };
  }
  return null;
}

// ---- buckets: mergeable per-layer statistics
const BIN_EDGES = [2, 5, 10, 20, 50, 100, 200], BIN_LABEL = ['<2', '2-5', '5-10', '10-20', '20-50', '50-100', '100-200', '200+'];
const newBucket = () => ({ count: 0, kinds: {}, colors: {}, styles: {}, widths: {}, heights: {}, mojiShu: {},
  lines: { n: 0, h: 0, v: 0, d: 0, zero: 0, sum: 0, max: 0, bins: Array(8).fill(0), longByStyle: {} } });
function mergeBuckets(...list) {
  const out = newBucket();
  for (const b of list) {
    out.count += b.count;
    for (const f of ['kinds', 'colors', 'styles', 'widths', 'heights', 'mojiShu']) for (const [k, v] of Object.entries(b[f])) inc(out[f], k, v);
    const l = b.lines, o = out.lines;
    for (const f of ['n', 'h', 'v', 'd', 'zero', 'sum']) o[f] += l[f];
    o.max = Math.max(o.max, l.max); l.bins.forEach((v, i) => { o.bins[i] += v; });
    for (const [k, v] of Object.entries(l.longByStyle)) inc(o.longByStyle, k, v);
  }
  return finalizeBucket(out);
}
function finalizeBucket(b) {
  for (const f of ['kinds', 'colors', 'styles', 'widths', 'heights', 'mojiShu']) b[f] = sortedHist(capHist(b[f]));
  const l = b.lines; l.sum = round(l.sum, 1); l.max = round(l.max, 1);
  let acc = 0, median = null;
  l.bins.forEach((v, i) => { acc += v; if (median === null && l.n && acc >= l.n / 2) median = BIN_LABEL[i]; });
  l.typical = { mean: l.n ? round(l.sum / l.n, 1) : 0, medianBin: median, max: l.max };
  l.longByStyle = sortedHist(l.longByStyle);
  return b;
}
function addRecord(b, r) {
  b.count++; inc(b.kinds, r.kind);
  if (r.kind !== 'block') {
    if (Number.isFinite(r.color)) inc(b.colors, r.color);
    if (r.kind === 'line' || r.kind === 'arc') { if (Number.isFinite(r.style)) inc(b.styles, r.style); if (Number.isFinite(r.width)) inc(b.widths, r.width); }
  }
  if (r.kind === 'text') {
    if (Number.isFinite(r.height)) inc(b.heights, round(r.height, 2));
    if (Number.isFinite(r.mojiShu)) inc(b.mojiShu, r.mojiShu);
  }
  if (r.kind === 'line' && r.lengthPaper !== undefined) {
    const l = b.lines; l.n++;
    if (r.lengthPaper < 1e-6) { l.zero++; return; }
    l.sum += r.lengthPaper; l.max = Math.max(l.max, r.lengthPaper);
    const bin = BIN_EDGES.findIndex(e => r.lengthPaper < e); l.bins[bin < 0 ? 7 : bin]++;
    l[r.orient]++;
    if (r.lengthPaper >= LONG && Number.isFinite(r.style)) inc(l.longByStyle, r.style);
  }
}

// ---- observation
function normalize(input) {
  if (!input || !Array.isArray(input.entities) || !Array.isArray(input.layers)) fail('E_LAYER_PROFILE_INPUT');
  const first = input.entities[0];
  const ir = first ? 'sourceProperties' in first : (input.schemaVersion === 2 || 'sourceHash' in input);
  if (ir) return { layers: input.layers, entities: input.entities, definitions: input.blockDefinitions ?? [], expanded: input.expandedEntities ?? [], sourceHash: input.sourceHash ?? null };
  const s = buildStructure(input);
  return { layers: input.layers, entities: s.entities, definitions: s.definitions, expanded: s.expanded, sourceHash: null };
}
const scaleOf = layer => Number.isFinite(layer?.scale) && layer.scale > 0 ? layer.scale : null;
const orientOf = (a, b) => {
  const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]), ang = Math.atan2(dy, dx) * 180 / Math.PI;
  return ang <= 1 ? 'h' : ang >= 89 ? 'v' : 'd';
};
// Metric record for one entity. top-level coordinates are paper mm; block children carry a model transform.
function metrics(local, props, geometry, matrix, scale, top) {
  const kind = KIND_OF[local.type] ?? 'other', p = props ?? {}, g = geometry;
  const r = { kind, color: p.m_nPenColor, style: p.m_nPenStyle, width: p.m_nPenWidth, model: [] };
  const factor = top ? 1 : (matrix && scale ? Math.sqrt(Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2])) / scale : NaN);
  const paper = pt => top ? pt : (matrix && scale ? transformPoint(matrix, pt).map(v => v / scale) : [NaN, NaN]);
  const model = pt => top ? (scale ? [pt[0] * scale, pt[1] * scale] : null) : (matrix ? transformPoint(matrix, pt) : null);
  const push = pt => { const m = model(pt); if (m && m.every(Number.isFinite)) r.model.push(m); };
  if (kind === 'line' && g?.kind === 'line') {
    const a = paper(g.start), b = paper(g.end);
    if ([...a, ...b].every(Number.isFinite)) { r.lengthPaper = Math.hypot(b[0] - a[0], b[1] - a[1]); r.orient = orientOf(a, b); }
    push(g.start); push(g.end);
  } else if (kind === 'text' && g?.kind === 'text') {
    r.text = typeof g.text === 'string' ? g.text : ''; r.mojiShu = p.m_nMojiShu;
    if (Number.isFinite(g.height) && Number.isFinite(factor)) r.height = g.height * factor;
    push(g.anchor);
  } else if (kind === 'arc' && g?.kind === 'ellipse-arc') {
    const c = model(g.center);
    if (c && c.every(Number.isFinite) && Number.isFinite(g.radius) && Number.isFinite(factor) && scale) {
      const rad = g.radius * factor * scale; r.model.push([c[0] - rad, c[1] - rad], [c[0] + rad, c[1] + rad]);
    }
  } else if (kind === 'point' && g?.kind === 'point') push(g.position);
  else if (kind === 'solid') for (const [x, y] of [['m_start_x', 'm_start_y'], ['m_end_x', 'm_end_y'], ['m_DPoint2_x', 'm_DPoint2_y'], ['m_DPoint3_x', 'm_DPoint3_y']]) { if (Number.isFinite(p[x]) && Number.isFinite(p[y])) push([p[x], p[y]]); }
  else if (kind === 'block' && Number.isFinite(p.m_DPKijunTen_x) && Number.isFinite(p.m_DPKijunTen_y)) push([p.m_DPKijunTen_x, p.m_DPKijunTen_y]);
  else if (kind === 'dim') { const line = local.components?.find(c => c.geometry?.kind === 'line'); if (line) { push(line.geometry.start); push(line.geometry.end); } }
  return r;
}

const TYPES = [
  ['plan', '平面図', '평면도', [[/平面図|平面詳細|間取/u, 3, 'text'], [/平面/u, 1, 'layer']]],
  ['elevation', '立面図', '입면도', [[/立面図?|[東西南北]面図/u, 3, 'text'], [/立面/u, 2, 'layer']]],
  ['section', '断面図', '단면도', [[/断面|矩計/u, 3, 'text'], [/断面|矩計/u, 2, 'layer']]],
  ['site', '配置図・敷地図', '배치도·부지도', [[/配置図|敷地図|求積|地積|案内図/u, 3, 'text'], [/敷地|隣地|道路/u, 1, 'layer'], [/敷地|隣地|道路/u, 1, 'text']]],
  ['shadow', '日影図', '일영도', [[/日影|日照|時刻/u, 3, 'text'], [/日影/u, 2, 'layer']]],
  ['sky', '天空率', '천공률', [[/天空/u, 3, 'text'], [/天空/u, 2, 'layer']]],
  ['detail', '詳細図', '상세도', [[/詳細図|ディテール|部分詳細/u, 3, 'text']]],
  ['development', '展開図', '전개도', [[/展開図/u, 3, 'text'], [/展開/u, 2, 'layer']]],
  ['framing', '伏図・軸組図', '복도·축조도', [[/伏図|軸組|基礎伏/u, 3, 'text'], [/伏図|軸組/u, 2, 'layer']]],
  ['mep', '設備図', '설비도', [[/設備図|配管|給排水|電気設備|空調/u, 3, 'text'], [/設備|配管|電気/u, 1, 'layer']]]
];
// Candidate only: keyword evidence from texts and layer names, never a verdict.
function classifyDrawing(texts, layerNames, roomHits) {
  const hits = TYPES.map(([id, ja, ko, rules]) => {
    let score = 0; const evidence = [];
    for (const [re, w, from] of rules) {
      const pool = from === 'text' ? texts : layerNames, matched = pool.filter(t => re.test(t));
      if (matched.length) { score += w * Math.min(matched.length, 3); evidence.push(`${from}:${trunc(matched[0], 16)}${matched.length > 1 ? `×${matched.length}` : ''}`); }
    }
    if (id === 'plan') {
      if (roomHits >= 3) { score += 2 + (roomHits >= 8 ? 1 : 0); evidence.push(`room names×${roomHits}`); }
      if (layerNames.some(n => /建具|室名|間仕切|躯体/u.test(n))) { score += 1; evidence.push('layer:建具/室名/間仕切'); }
    }
    return { type: id, ja, ko, score, confidence: round(score / (score + 3), 2), evidence };
  // Ties go to the more specific (later) type, e.g. 天空率 over 配置図.
  }).filter(h => h.score > 0).sort((a, b) => b.score - a.score || TYPES.findIndex(t => t[0] === b.type) - TYPES.findIndex(t => t[0] === a.type));
  return { candidate: true, best: hits[0]?.type ?? 'unknown', candidates: hits.slice(0, 4) };
}

/** Per-layer statistics of one drawing (readJww document or toIR output). `meta` = {name, sourceHash}. */
export function observeDrawing(input, meta = {}) {
  const n = normalize(input), layerMeta = new Map(n.layers.map(l => [l.id, l]));
  const defIndex = new Map(), index = e => { defIndex.set(e.id, e); (e.components ?? []).forEach(index); };
  n.definitions.forEach(d => d.entities.forEach(index));
  const layers = new Map(), texts = [], overall = { top: 0, child: 0, skippedScale: 0, bbox: null };
  const get = id => {
    let o = layers.get(id);
    if (!o) {
      const l = layerMeta.get(id) ?? {};
      o = { id, groupName: l.groupName ?? '', name: l.name ?? '', scale: l.scale ?? null, state: l.state ?? null, top: newBucket(), child: newBucket(),
        text: { n: 0, chars: 0, short: 0, roomHits: 0, samples: [] }, bbox: null };
      layers.set(id, o);
    }
    return o;
  };
  const record = (o, bucket, r) => {
    addRecord(bucket, r);
    for (const m of r.model) {
      o.bbox = o.bbox ? [Math.min(o.bbox[0], m[0]), Math.min(o.bbox[1], m[1]), Math.max(o.bbox[2], m[0]), Math.max(o.bbox[3], m[1])] : [m[0], m[1], m[0], m[1]];
    }
    if (r.kind === 'text' && typeof r.text === 'string') {
      const t = o.text, s = r.text.normalize('NFKC');
      t.n++; t.chars += Array.from(s).length; if (Array.from(s).length <= 6) t.short++; if (ROOM.test(s.toLowerCase())) t.roomHits++;
      if (texts.length < 20000) texts.push(norm(s).slice(0, 200));
      const sample = trunc(r.text.trim(), 24);
      if (sample && t.samples.length < 5 && !t.samples.includes(sample)) t.samples.push(sample);
    }
  };
  const topType = new Map();
  for (const e of n.entities) {
    topType.set(e.id, e.type);
    const o = get(e.layerId), scale = scaleOf(layerMeta.get(e.layerId));
    if (!scale) overall.skippedScale++;
    record(o, o.top, metrics(e, e.sourceProperties, e.geometry, null, scale, true)); overall.top++;
  }
  for (const item of n.expanded) {
    if (!item.path.includes('/') || topType.get(item.path.split('/')[0]) === 'JwwSunpou') continue; // top-level counted above; dimension parts belong to the dimension
    const o = get(item.effectiveLayerId), local = defIndex.get(item.sourceEntityId), scale = scaleOf(layerMeta.get(item.effectiveLayerId));
    record(o, o.child, metrics({ type: item.type, components: local?.components }, local?.sourceProperties, item.geometry, item.transformToModel, scale, false)); overall.child++;
  }
  for (const l of n.layers) {
    const name = norm(l.name);
    if (name && !DEFAULT_LAYER.test(name)) get(l.id);
  }
  const list = [...layers.values()].sort((a, b) => natural(a.id, b.id)).map(o => {
    const count = o.top.count + o.child.count, t = o.text;
    for (const m of ['top', 'child']) finalizeBucket(o[m]);
    if (o.bbox) o.bbox = o.bbox.map(v => round(v, 1));
    if (o.bbox) overall.bbox = overall.bbox ? [Math.min(overall.bbox[0], o.bbox[0]), Math.min(overall.bbox[1], o.bbox[1]), Math.max(overall.bbox[2], o.bbox[2]), Math.max(overall.bbox[3], o.bbox[3])] : [...o.bbox];
    return { id: o.id, groupName: o.groupName, name: o.name, scale: o.scale, state: o.state, count, top: o.top, child: o.child,
      text: { n: t.n, avgChars: t.n ? round(t.chars / t.n, 1) : 0, short: t.short, roomHits: t.roomHits, samples: t.samples }, bbox: o.bbox };
  });
  const roomHits = sum(list.map(l => l.text.roomHits));
  return { schemaVersion: LAYER_PROFILE_SCHEMA, name: meta.name ?? null, sourceHash: meta.sourceHash ?? n.sourceHash ?? null,
    counts: { topLevel: overall.top, blockChildren: overall.child, skippedInvalidScale: overall.skippedScale, layers: list.length },
    bbox: overall.bbox?.map(v => round(v, 1)) ?? null, layers: list,
    drawingType: classifyDrawing(texts, n.layers.filter(l => layers.has(l.id)).map(l => norm(l.name)).filter(Boolean), roomHits) };
}

// ---- role assignment
const mergedOf = o => mergeBuckets(o.top, o.child);
function roleFromContent(o) {
  const m = mergedOf(o), total = m.count;
  if (!total) return null;
  const dims = (o.top.kinds.dim ?? 0);
  if (dims >= 3 && dims / Math.max(1, o.top.count) >= 0.5) return { role: 'dimension', confidence: 0.8, evidence: [`dimension entities ${dims}/${o.top.count}`] };
  const lines = m.lines, chain = sum(CHAIN.map(s => lines.longByStyle[s] ?? 0));
  if (chain >= 3 && chain / Math.max(1, lines.n) >= 0.6 && (lines.h + lines.v) / Math.max(1, lines.n - lines.zero) >= 0.8)
    return { role: 'grid', confidence: 0.7, evidence: [`long chain-line (一点鎖線) ${chain}/${lines.n} lines, ${Math.round(100 * (lines.h + lines.v) / Math.max(1, lines.n - lines.zero))}% horizontal/vertical`] };
  const texts = m.kinds.text ?? 0;
  if (texts >= 3 && texts / total >= 0.6) {
    const rooms = o.text.roomHits;
    return rooms >= 2 ? { role: 'text', confidence: 0.7, evidence: [`text ${texts}/${total}, room-name texts ${rooms}`] } : { role: 'text', confidence: 0.6, evidence: [`text ${texts}/${total}, avg ${o.text.avgChars} chars`] };
  }
  const solids = m.kinds.solid ?? 0;
  if (solids >= 3 && solids / total >= 0.6) return { role: 'hatch', confidence: 0.55, evidence: [`solid fills ${solids}/${total}`] };
  return null;
}

/** Name first, then content. Always returns evidence; unknown stays unknown. */
export function assignLayerRole(layer) {
  const byName = roleFromName(layer.name, layer.groupName), byContent = layer.count > 0 ? roleFromContent(layer) : null;
  const base = { nameRole: byName?.role ?? null, contentRole: byContent?.role ?? null };
  if (byName) {
    let confidence = byName.confidence, source = 'name'; const evidence = [...byName.evidence];
    if (byContent) {
      if (byContent.role === byName.role) { confidence = Math.min(0.97, confidence + 0.07); source = 'name+content'; evidence.push(...byContent.evidence); }
      else if (COMPATIBLE.has(`${byContent.role}|${byName.role}`)) evidence.push(`content (${byContent.role}) is compatible: ${byContent.evidence[0]}`);
      else if (byContent.confidence >= 0.6) { confidence = round(Math.max(0.2, confidence - 0.25), 2); evidence.push(`content suggests ${byContent.role}: ${byContent.evidence[0]}`); }
    }
    return { role: byName.role, confidence: round(confidence, 2), source, evidence, ...base };
  }
  if (byContent) return { role: byContent.role, confidence: byContent.confidence, source: 'content', evidence: byContent.evidence, ...base };
  return { role: 'unknown', confidence: 0, source: 'none', evidence: ['no layer-name keyword or content signal'], ...base };
}

// ---- profile
const allowedOf = (hist, minShare, minEvidence) => {
  const total = sum(Object.values(hist));
  if (total < minEvidence) return null;
  return Object.entries(hist).filter(([k, v]) => k !== '*' && v / total >= minShare).map(([k]) => Number(k)).sort((a, b) => a - b);
};
const topNames = names => [...names.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 3).map(([name, count]) => ({ name, count }));
const bucketOut = b => ({ count: b.count, kinds: b.kinds, hist: { colors: b.colors, styles: b.styles, widths: b.widths, textHeights: b.heights, mojiShu: b.mojiShu } });
// Allowed sets are null when the evidence is too thin to call anything a violation.
const allowedBlock = (b, minShare, minEvidence) => ({ colors: allowedOf(b.colors, minShare, minEvidence), styles: allowedOf(b.styles, minShare, minEvidence),
  widths: allowedOf(b.widths, minShare, minEvidence), textHeights: allowedOf(b.heights, minShare, Math.min(minEvidence, 5)) });

export function buildProfile(observations, { minSupport = 2, minShare = 0.03, minEvidence = 10, keepSamples = false, minDrawingsForUnused = 3 } = {}) {
  if (!Array.isArray(observations)) fail('E_LAYER_PROFILE_INPUT');
  if (!observations.length) fail('E_LAYER_PROFILE_EMPTY');
  for (const o of observations) if (!o || o.schemaVersion !== LAYER_PROFILE_SCHEMA || !Array.isArray(o.layers)) fail('E_LAYER_PROFILE_INPUT', 'observation');
  const eff = Math.max(1, Math.min(minSupport, observations.length));
  const acc = new Map(), roleSeen = new Map(), types = {};
  observations.forEach((obs, di) => {
    inc(types, obs.drawingType?.best ?? 'unknown');
    for (const layer of obs.layers) {
      const a = assignLayerRole(layer);
      let L = acc.get(layer.id);
      if (!L) { L = { drawings: new Set(), used: new Set(), byRole: new Map(), samples: [], scales: {}, names: new Map(), groups: new Map() }; acc.set(layer.id, L); }
      L.drawings.add(di); if (layer.count > 0) L.used.add(di);
      const R = L.byRole.get(a.role) ?? { drawings: new Set(), confSum: 0, entities: 0, evidence: new Map(), names: new Map(), buckets: [] };
      L.byRole.set(a.role, R); R.drawings.add(di); R.confSum += a.confidence; R.entities += layer.top.count; R.buckets.push(layer.top);
      for (const e of a.evidence) R.evidence.set(e, (R.evidence.get(e) ?? 0) + 1);
      if (layer.name.trim()) { L.names.set(layer.name.trim(), (L.names.get(layer.name.trim()) ?? 0) + 1); R.names.set(layer.name.trim(), (R.names.get(layer.name.trim()) ?? 0) + 1); }
      if (layer.groupName.trim()) L.groups.set(layer.groupName.trim(), (L.groups.get(layer.groupName.trim()) ?? 0) + 1);
      if (layer.count > 0 && Number.isFinite(layer.scale)) inc(L.scales, layer.scale);
      for (const s of layer.text.samples) if (L.samples.length < 50 && !L.samples.includes(s)) L.samples.push(s);
      if (a.role !== 'unknown') { const set = roleSeen.get(a.role) ?? new Set(); set.add(di); roleSeen.set(a.role, set); }
    }
  });
  // Layer entries are keyed by layer id (the convention unit); role entries pool every assignment of that role, even from layers whose ids disagree.
  const layers = {}, rolePairs = {};
  for (const id of [...acc.keys()].sort(natural)) {
    const L = acc.get(id), known = [...L.byRole.entries()].filter(([r]) => r !== 'unknown');
    known.sort((a, b) => b[1].drawings.size - a[1].drawings.size || b[1].entities - a[1].entities || cmp(a[0], b[0]));
    const roles = [...L.byRole.entries()].sort((a, b) => b[1].drawings.size - a[1].drawings.size || cmp(a[0], b[0])).map(([role, r]) => ({ role, support: r.drawings.size }));
    const scale = Object.entries(L.scales).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    const base = { drawings: L.drawings.size, usedIn: L.used.size, names: topNames(L.names), scale: scale ? Number(scale[0]) : null };
    const entry = { role: 'unknown', confidence: 0, support: L.used.size, ...base, roles };
    for (const [role, R] of known) (rolePairs[role] ??= []).push({ id, R, L });
    if (known.length) {
      const [role, R] = known[0], support = R.drawings.size, confidence = round((R.confSum / support) * (support / L.drawings.size), 2), pool = mergeBuckets(...R.buckets);
      if (support >= eff) {
        Object.assign(entry, { role, confidence, support, evidence: [...R.evidence.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 3).map(e => e[0]),
          ...bucketOut(pool), allowed: allowedBlock(pool, minShare, minEvidence), entityCount: R.entities });
      } else Object.assign(entry, { lowSupport: true, candidateRole: role, candidateSupport: support });
    }
    if (keepSamples && L.samples.length) entry.samples = [...L.samples].sort(cmp).slice(0, 5);
    layers[id] = entry;
  }
  const roles = {};
  for (const role of Object.keys(ROLES).filter(r => r !== 'unknown')) {
    if (!roleSeen.has(role)) continue;
    const pairs = rolePairs[role] ?? [], pool = mergeBuckets(...pairs.flatMap(x => x.R.buckets));
    const entries = pairs.map(({ id, R, L }) => ({ layerId: id, support: R.drawings.size, confidence: round(R.confSum / R.drawings.size, 2), entityCount: R.entities,
      names: topNames(R.names), primary: layers[id].role === role, lowSupport: R.drawings.size < eff }))
      .sort((a, b) => Number(b.primary) - Number(a.primary) || Number(a.lowSupport) - Number(b.lowSupport) || b.support - a.support || b.confidence - a.confidence || b.entityCount - a.entityCount || natural(a.layerId, b.layerId));
    const names = new Map(); let confSum = 0, n = 0;
    for (const { R } of pairs) { confSum += R.confSum; n += R.drawings.size; for (const [k, v] of R.names) names.set(k, (names.get(k) ?? 0) + v); }
    const entry = { ja: ROLES[role].ja, ko: ROLES[role].ko, support: roleSeen.get(role).size, confidence: n ? round(confSum / n, 2) : 0,
      layers: entries, names: [...names.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 8).map(([name, count]) => ({ name, count })),
      primaryKinds: ROLES[role].primary, forbiddenKinds: ROLES[role].forbidden, ...bucketOut(pool), allowed: allowedBlock(pool, minShare, minEvidence) };
    if (role === 'grid') {
      const long = pool.lines.longByStyle, total = sum(Object.values(long));
      entry.gridStyles = total >= 20 ? Object.keys(long).filter(s => long[s] / total >= 0.1).map(Number).sort((a, b) => a - b) : null;
    }
    roles[role] = entry;
  }
  const used = Object.keys(layers).filter(id => acc.get(id).used.size > 0).sort(natural);
  return { schemaVersion: LAYER_PROFILE_SCHEMA, kind: 'jw-office-layer-profile',
    params: { minSupport, effectiveMinSupport: eff, minShare, minEvidence }, drawingCount: observations.length,
    sourceDrawings: observations.map(o => ({ name: o.name, sha256: o.sourceHash })).sort((a, b) => cmp(a.name ?? '', b.name ?? '') || cmp(a.sha256 ?? '', b.sha256 ?? '')),
    drawingTypes: sortedHist(types), roles, layers,
    usage: { enabled: observations.length >= minDrawingsForUnused, minDrawings: minDrawingsForUnused, usedLayers: used } };
}

export function validateProfile(profile) {
  if (!profile || typeof profile !== 'object' || profile.kind !== 'jw-office-layer-profile' || profile.schemaVersion !== LAYER_PROFILE_SCHEMA
    || !profile.roles || typeof profile.roles !== 'object' || !profile.layers || typeof profile.layers !== 'object' || !profile.usage) fail('E_LAYER_PROFILE_SCHEMA');
  return profile;
}

// ---- checking
const SEVERITY = { error: 0, warning: 1, info: 2 };
const layerText = (id, name) => name ? `${id}「${name}」` : id;
const kindJa = { line: '線', arc: '円・円弧', point: '点', text: '文字', dim: '寸法', solid: 'ソリッド', block: 'ブロック(図形)', other: 'その他' };
const kindKo = { line: '선', arc: '원·호', point: '점', text: '문자', dim: '치수', solid: '솔리드', block: '블록(도형)', other: '기타' };
const idsText = (list, lang) => list.map(k => lang === 'ja' ? kindJa[k] : kindKo[k]).join('・');

function resolveContext(profile, layerId, docLayer) {
  const pl = profile.layers[layerId], byName = roleFromName(docLayer?.name, docLayer?.groupName);
  const out = { layerId, name: docLayer?.name?.trim() || pl?.names?.[0]?.name || '', profileRole: pl && pl.role !== 'unknown' && pl.confidence >= 0.5 ? pl.role : null, nameRole: byName && byName.confidence >= 0.8 ? byName.role : null, profileLayer: pl ?? null, ctx: null };
  if (out.profileRole && pl.confidence >= 0.5) out.ctx = { role: pl.role, confidence: pl.confidence, support: pl.support, source: 'profile-layer', allowed: pl.allowed, kinds: pl.kinds ?? {} };
  else if (out.nameRole && profile.roles[out.nameRole]) {
    const r = profile.roles[out.nameRole];
    out.ctx = { role: out.nameRole, confidence: byName.confidence, support: r.support, source: 'layer-name', allowed: r.allowed, kinds: r.kinds ?? {} };
  }
  return out;
}
const confident = ctx => ctx.confidence >= 0.8 && ctx.support >= 2;
function kindTier(ctx, kind) {
  if (!ctx || kind === 'other') return null;
  const def = ROLES[ctx.role];
  if (def.forbidden.includes(kind)) return 'forbidden';
  const total = sum(Object.values(ctx.kinds ?? {}));
  return !def.primary.includes(kind) && total >= 10 && (ctx.kinds[kind] ?? 0) / total < 0.02 ? 'unusual' : null;
}
const near = (list, v, tol) => list.some(x => Math.abs(x - v) <= tol);

/** Rule violations of one record on its resolved layer. rec: {kind,color,style,width,height,lengthPaper}. */
function violations(rec, rc, profile, opts) {
  const out = [], ctx = rc.ctx, L = layerText(rc.layerId, rc.name);
  if (ctx) {
    const tier = kindTier(ctx, rec.kind), role = ctx.role;
    // When most of the layer in this drawing is that kind, it is the layer's purpose, not a stray: report as info (name/role disagreement).
    const dominant = tier && rec.layerShare >= 0.5, pct = Math.round((rec.layerShare ?? 0) * 100);
    if (tier) out.push({ ruleId: 'layer.kind-unexpected', severity: dominant ? 'info' : tier === 'forbidden' ? (confident(ctx) ? 'error' : 'warning') : (confident(ctx) ? 'warning' : 'info'), key: rec.kind,
      expected: { role, kinds: ROLES[role].primary, forbidden: ROLES[role].forbidden }, actual: { kind: rec.kind, tier, ...(rec.layerShare !== undefined ? { layerShare: round(rec.layerShare, 2) } : {}) },
      ja: `${L} は「${roleName(role, 'ja')}」レイヤですが ${kindJa[rec.kind]} があります（想定: ${idsText(ROLES[role].primary, 'ja')}）。${dominant ? `レイヤの${pct}%がこの種類のため、用途とレイヤ名の不一致の可能性があります。` : ''}`,
      ko: `${L} 은(는) '${roleName(role, 'ko')}' 레이어인데 ${kindKo[rec.kind]}이(가) 있습니다 (예상: ${idsText(ROLES[role].primary, 'ko')}).${dominant ? ` 레이어의 ${pct}%가 이 종류라서 용도와 레이어 이름이 다를 가능성이 있습니다.` : ''}` });
    const grid = role === 'grid' && rec.kind === 'line' && rec.lengthPaper >= opts.gridMinLength;
    if (grid && Number.isFinite(rec.style)) {
      const allowed = opts.gridStyles ?? (profile.roles.grid?.gridStyles?.length ? profile.roles.grid.gridStyles : CHAIN);
      if (!allowed.includes(rec.style)) out.push({ ruleId: 'grid.linetype', severity: 'warning', key: String(rec.style), expected: { styles: allowed }, actual: { style: rec.style },
        ja: `${L} は通り芯レイヤですが、長い線の線種が ${styleName(rec.style, 0)} です（想定: ${allowed.map(s => styleName(s, 0)).join('・')}）。`,
        ko: `${L} 은(는) 통심 레이어인데 긴 선의 선종이 ${styleName(rec.style, 1)}입니다 (예상: ${allowed.map(s => styleName(s, 1)).join('·')}).` });
    }
    // Role-pooled sets (layer not in the profile) are weaker evidence than a layer-specific convention.
    const a = ctx.allowed ?? {}, sev = confident(ctx) && ctx.source === 'profile-layer' ? 'warning' : 'info';
    if (rec.kind !== 'block') {
      if (Number.isFinite(rec.color) && a.colors?.length && !a.colors.includes(rec.color)) out.push({ ruleId: 'layer.pen-color', severity: sev, key: String(rec.color), expected: { colors: a.colors }, actual: { color: rec.color },
        ja: `${L}（${roleName(role, 'ja')}）のペン色 ${rec.color} は通常の色 ${a.colors.join('・')} の範囲外です。`, ko: `${L}(${roleName(role, 'ko')})의 펜 색 ${rec.color} 은(는) 일반적인 색 ${a.colors.join('·')} 범위 밖입니다.` });
      if ((rec.kind === 'line' || rec.kind === 'arc') && !grid) {
        if (Number.isFinite(rec.style) && a.styles?.length && !a.styles.includes(rec.style)) out.push({ ruleId: 'layer.pen-style', severity: sev, key: String(rec.style), expected: { styles: a.styles }, actual: { style: rec.style },
          ja: `${L}（${roleName(role, 'ja')}）の線種 ${styleName(rec.style, 0)} は通常の線種 ${a.styles.map(s => styleName(s, 0)).join('・')} の範囲外です。`,
          ko: `${L}(${roleName(role, 'ko')})의 선종 ${styleName(rec.style, 1)} 은(는) 일반적인 선종 ${a.styles.map(s => styleName(s, 1)).join('·')} 범위 밖입니다.` });
      }
      if ((rec.kind === 'line' || rec.kind === 'arc') && Number.isFinite(rec.width) && a.widths?.length && !a.widths.includes(rec.width)) out.push({ ruleId: 'layer.pen-width', severity: 'info', key: String(rec.width), expected: { widths: a.widths }, actual: { width: rec.width },
        ja: `${L} の線幅 ${rec.width} は通常の ${a.widths.join('・')} の範囲外です。`, ko: `${L} 의 선 굵기 ${rec.width} 은(는) 일반적인 ${a.widths.join('·')} 범위 밖입니다.` });
    }
    if (rec.kind === 'text' && Number.isFinite(rec.height) && a.textHeights?.length && !near(a.textHeights, rec.height, 0.05)) out.push({ ruleId: 'layer.text-height', severity: sev, key: String(round(rec.height, 2)),
      expected: { heights: a.textHeights }, actual: { height: round(rec.height, 2) },
      ja: `${L}（${roleName(role, 'ja')}）の文字高さ ${round(rec.height, 2)}mm は標準 ${a.textHeights.join('・')}mm にありません。`,
      ko: `${L}(${roleName(role, 'ko')})의 문자 높이 ${round(rec.height, 2)}mm 은(는) 표준 ${a.textHeights.join('·')}mm 에 없습니다.` });
  }
  if (profile.usage.enabled && !profile.layers[rc.layerId]) out.push({ ruleId: 'layer.unused', severity: 'info', key: '-', expected: { usedLayers: profile.usage.usedLayers.length }, actual: { layerId: rc.layerId },
    ja: `${L} は事務所の既存図面で使われていないレイヤです。`, ko: `${L} 은(는) 사무소 기존 도면에서 사용된 적 없는 레이어입니다.` });
  return out;
}

function collector() {
  const map = new Map();
  return {
    add(layerId, v, entityId, scope = '', extra = {}) {
      const key = `${v.ruleId}|${layerId}|${v.key}${scope ? `|${scope}` : ''}`;
      let f = map.get(key);
      if (!f) { f = { id: key, ruleId: v.ruleId, severity: v.severity, entityIds: new Set(), layerId, expected: v.expected, actual: v.actual, message_ja: v.ja, message_ko: v.ko, ...extra }; map.set(key, f); }
      if (entityId !== undefined && entityId !== null) f.entityIds.add(entityId);
    },
    done() {
      return [...map.values()].map(f => {
        const ids = [...f.entityIds].sort(natural), count = ids.length;
        return { ...f, entityIds: ids, count, message_ja: count > 1 ? `${f.message_ja}（${count}件）` : f.message_ja, message_ko: count > 1 ? `${f.message_ko} (${count}건)` : f.message_ko };
      }).sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || cmp(a.ruleId, b.ruleId) || natural(a.layerId, b.layerId) || cmp(a.id, b.id));
    }
  };
}
const summarize = findings => ({ error: findings.filter(f => f.severity === 'error').length, warning: findings.filter(f => f.severity === 'warning').length, info: findings.filter(f => f.severity === 'info').length });
const DEFAULT_OPTS = { gridMinLength: GRID_MIN };

/** Check a readJww document or toIR output against the profile. Block children are not checked; their block instance is. */
export function checkLayers(input, profile, options = {}) {
  validateProfile(profile);
  const opts = { ...DEFAULT_OPTS, ...options }, n = normalize(input), docLayers = new Map(n.layers.map(l => [l.id, l])), found = collector(), cache = new Map();
  const ctxOf = id => cache.get(id) ?? (cache.set(id, resolveContext(profile, id, docLayers.get(id))), cache.get(id));
  const counts = new Map();
  for (const e of n.entities) { const c = counts.get(e.layerId) ?? { total: 0 }; c.total++; const k = KIND_OF[e.type] ?? 'other'; c[k] = (c[k] ?? 0) + 1; counts.set(e.layerId, c); }
  for (const e of n.entities) {
    const rc = ctxOf(e.layerId), p = e.sourceProperties ?? {}, g = e.geometry;
    const kind = KIND_OF[e.type] ?? 'other', c = counts.get(e.layerId);
    const rec = { kind, color: p.m_nPenColor, style: p.m_nPenStyle, width: p.m_nPenWidth, layerShare: c[kind] / c.total };
    if (kind === 'line' && g?.kind === 'line') rec.lengthPaper = Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1]);
    if (kind === 'text' && g?.kind === 'text') rec.height = g.height;
    for (const v of violations(rec, rc, profile, opts)) found.add(e.layerId, v, e.id);
    if (rc.profileRole && rc.nameRole && rc.profileRole !== rc.nameRole) {
      const L = layerText(e.layerId, rc.name);
      found.add(e.layerId, { ruleId: 'layer.role-mismatch', severity: 'warning', key: rc.nameRole, expected: { role: rc.profileRole }, actual: { role: rc.nameRole },
        ja: `${L} の名前は「${roleName(rc.nameRole, 'ja')}」を示しますが、事務所プロファイルではこのレイヤは「${roleName(rc.profileRole, 'ja')}」です。`,
        ko: `${L} 의 이름은 '${roleName(rc.nameRole, 'ko')}'을(를) 가리키지만 사무소 프로파일에서 이 레이어는 '${roleName(rc.profileRole, 'ko')}'입니다.` }, e.id);
    }
  }
  const findings = found.done();
  return { findings, summary: summarize(findings), checkedEntities: n.entities.length };
}

// ---- patch checking
const accepts = (ctx, kind) => !kindTier(ctx, kind);
// Geometry-bearing roles only: a stray line should not default to the grid or a title block just because those layers hold many lines.
const GENERIC = new Set(['wall', 'structure', 'opening', 'finish', 'stair', 'roof', 'equipment', 'furniture', 'site', 'elevation']);
function popularRole(profile, kind) {
  let best = null, bestN = 0;
  for (const role of Object.keys(profile.roles).filter(r => GENERIC.has(r))) {
    const r = profile.roles[role], count = r.kinds?.[kind] ?? 0;
    if (!r.layers.length || ROLES[role].forbidden.includes(kind) || !ROLES[role].primary.includes(kind)) continue;
    if (count > bestN) { best = role; bestN = count; }
  }
  return best;
}
/** Where should a new entity of this kind live? Hint role wins; then kind (text, chain line); then the current layer if it accepts the kind. */
export function suggestLayer(kind, info, profile, docLayers, currentCtx = null) {
  const layers = docLayers instanceof Map ? docLayers : new Map([...docLayers].map(id => [id, { id }]));
  let role = info.hint ?? null, reason = info.hint ? 'role-hint' : null;
  if (!role && kind === 'line' && CHAIN.includes(info.style) && info.lengthPaper >= GRID_MIN && profile.roles.grid) { role = 'grid'; reason = 'chain-line'; }
  if (!role && currentCtx && accepts(currentCtx, kind)) return { layerId: info.current, role: currentCtx.role, reason: 'kept' };
  if (!role && kind === 'text' && profile.roles.text) { role = 'text'; reason = 'kind'; }
  if (!role) { role = popularRole(profile, kind); reason = role ? 'popular-for-kind' : null; }
  if (!role) return { layerId: null, role: null, reason: 'no-role' };
  if (currentCtx?.role === role) return { layerId: info.current, role, reason: 'kept' };
  // Office convention first (when this drawing's own layer name does not contradict it), then a layer this drawing names for the role, then weak profile layers.
  const mine = profile.roles[role]?.layers.filter(l => layers.has(l.layerId)) ?? [], nameRole = id => roleFromName(layers.get(id)?.name, layers.get(id)?.groupName)?.role;
  const named = [...layers.keys()].sort(natural).find(id => nameRole(id) === role);
  const target = mine.find(l => !l.lowSupport && (!nameRole(l.layerId) || nameRole(l.layerId) === role))?.layerId ?? named ?? mine.find(l => !nameRole(l.layerId) || nameRole(l.layerId) === role)?.layerId ?? null;
  return target ? { layerId: target, role, reason } : { layerId: null, role, reason: 'no-layer-for-role' };
}

const lengthPaperOf = (e, layers) => {
  const scale = scaleOf(layers.get(e.layer));
  return scale ? Math.hypot(e.end[0] - e.start[0], e.end[1] - e.start[1]) / scale : undefined;
};
/**
 * Pre-apply check of normalized Patch v2 ops (validatePatchV2().ops) against the IR they were generated from.
 * options: {roleHint, roleHints:{[tempId|opIndex]: role}}. Returns findings, per-add suggestions, auto-applicable corrections and a verdict.
 */
export function checkPatchLayers(ops, ir, profile, options = {}) {
  validateProfile(profile);
  if (!Array.isArray(ops) || !ir || !Array.isArray(ir.layers) || !Array.isArray(ir.entities)) fail('E_LAYER_PROFILE_INPUT');
  const opts = { ...DEFAULT_OPTS, ...options }, docLayers = new Map(ir.layers.map(l => [l.id, l]));
  for (const h of [options.roleHint, ...Object.values(options.roleHints ?? {})]) if (h !== undefined && h !== null && (!ROLES[h] || h === 'unknown')) fail('E_LAYER_PROFILE_INPUT', `roleHint=${h}`);
  const found = collector(), cache = new Map(), suggestions = [], corrections = [];
  const ctxOf = id => cache.get(id) ?? (cache.set(id, resolveContext(profile, id, docLayers.get(id))), cache.get(id));
  const state = new Map(ir.entities.map(e => [e.id, { kind: KIND_OF[e.type] ?? e.kind ?? 'other', layer: e.layerId, color: e.sourceProperties?.m_nPenColor, style: e.sourceProperties?.m_nPenStyle,
    width: e.sourceProperties?.m_nPenWidth, height: e.geometry?.height }]));
  const hintFor = (op, i) => options.roleHints?.[op.tempId ?? ''] ?? options.roleHints?.[String(i)] ?? options.roleHint ?? null;
  const emit = (i, rec, layerId, id, hint, op, path, ref) => {
    const rc = ctxOf(layerId), scope = `op${i}`;
    const sug = suggestLayer(rec.kind, { hint, style: rec.style, lengthPaper: rec.lengthPaper, current: layerId }, profile, docLayers, rc.ctx);
    const fix = sug.layerId && sug.layerId !== layerId ? { suggestedLayer: sug.layerId, suggestedRole: sug.role } : {};
    const extra = { opIndex: i, ...(op.tempId ? { tempId: op.tempId } : {}), ...fix };
    for (const v of violations(rec, rc, profile, opts)) {
      const relocate = v.ruleId === 'layer.kind-unexpected' && fix.suggestedLayer;
      found.add(layerId, { ...v, ruleId: v.ruleId.startsWith('layer.') ? `patch.${v.ruleId.slice(6)}` : v.ruleId }, id, scope, relocate ? extra : { opIndex: i, ...(op.tempId ? { tempId: op.tempId } : {}) });
    }
    if (hint && rc.ctx?.role !== hint && (rc.ctx || fix.suggestedLayer)) {
      const L = layerText(layerId, rc.name), have = rc.ctx?.role ?? 'unknown';
      found.add(layerId, { ruleId: 'patch.role-mismatch', severity: rc.ctx ? (confident(rc.ctx) ? 'error' : 'warning') : 'info', key: hint, expected: { role: hint }, actual: { role: have },
        ja: `${L} は「${roleName(have, 'ja')}」レイヤですが、指示の想定は「${roleName(hint, 'ja')}」です。`,
        ko: `${L} 은(는) '${roleName(have, 'ko')}' 레이어이지만 지시의 예상은 '${roleName(hint, 'ko')}'입니다.` }, id, scope, extra);
    }
    if (fix.suggestedLayer && (hint ? rc.ctx?.role !== hint : !!kindTier(rc.ctx, rec.kind))) corrections.push({ opIndex: i, path, from: layerId, to: fix.suggestedLayer, role: sug.role, reason: sug.reason, ref });
    return sug;
  };
  ops.forEach((op, i) => {
    if (op.op === 'add') {
      const e = op.entity, rec = { kind: e.kind, color: e.kind === 'text' ? e.color : e.pen?.color, style: e.pen?.style, width: e.pen?.width, height: e.height, lengthPaper: e.kind === 'line' ? lengthPaperOf(e, docLayers) : undefined };
      const hint = hintFor(op, i), sug = emit(i, rec, e.layer, op.tempId ?? `op${i}`, hint, op, 'entity.layer', op.tempId ?? null);
      suggestions.push({ opIndex: i, tempId: op.tempId ?? null, kind: e.kind, layer: e.layer, suggestedLayer: sug.layerId, suggestedRole: sug.role, reason: sug.reason, changed: !!sug.layerId && sug.layerId !== e.layer });
      if (op.tempId) state.set(op.tempId, { kind: e.kind, layer: e.layer, ...rec });
    } else if (op.op === 'setLayer') {
      const groups = new Map();
      for (const id of op.ids) { const s = state.get(id); if (s) (groups.get(s.kind) ?? groups.set(s.kind, []).get(s.kind)).push(id); }
      for (const [kind, ids] of groups) {
        const rec = { kind }, hint = options.roleHints?.[String(i)] ?? options.roleHint ?? null, rc = ctxOf(op.layer), scope = `op${i}`;
        for (const v of violations(rec, rc, profile, opts)) if (v.ruleId === 'layer.kind-unexpected') {
          const sug = suggestLayer(kind, { hint, current: op.layer }, profile, docLayers, rc.ctx), fix = sug.layerId && sug.layerId !== op.layer ? { suggestedLayer: sug.layerId, suggestedRole: sug.role } : {};
          ids.forEach(id => found.add(op.layer, { ...v, ruleId: 'patch.kind-unexpected' }, id, scope, { opIndex: i, ...fix }));
        }
        if (hint && rc.ctx && rc.ctx.role !== hint) {
          const L = layerText(op.layer, rc.name), sug = suggestLayer(kind, { hint, current: op.layer }, profile, docLayers, rc.ctx);
          ids.forEach(id => found.add(op.layer, { ruleId: 'patch.role-mismatch', severity: confident(rc.ctx) ? 'error' : 'warning', key: hint, expected: { role: hint }, actual: { role: rc.ctx.role },
            ja: `${L} は「${roleName(rc.ctx.role, 'ja')}」レイヤですが、指示の想定は「${roleName(hint, 'ja')}」です。`,
            ko: `${L} 은(는) '${roleName(rc.ctx.role, 'ko')}' 레이어이지만 지시의 예상은 '${roleName(hint, 'ko')}'입니다.` }, id, scope, { opIndex: i, ...(sug.layerId && sug.layerId !== op.layer ? { suggestedLayer: sug.layerId, suggestedRole: sug.role } : {}) }));
        }
        const tier = kindTier(rc.ctx, kind), sug = tier || (hint && rc.ctx && rc.ctx.role !== hint) ? suggestLayer(kind, { hint, current: op.layer }, profile, docLayers, rc.ctx) : null;
        if (sug?.layerId && sug.layerId !== op.layer) corrections.push({ opIndex: i, path: 'layer', from: op.layer, to: sug.layerId, role: sug.role, reason: sug.reason, ref: null });
      }
      for (const id of op.ids) { const s = state.get(id); if (s) s.layer = op.layer; }
    } else if (op.op === 'setPen') {
      for (const id of op.ids) {
        const s = state.get(id); if (!s) continue;
        const rec = { kind: s.kind, color: op.pen.color, style: op.pen.style, width: op.pen.width, lengthPaper: undefined };
        for (const v of violations(rec, ctxOf(s.layer), profile, opts)) if (/^layer\.pen-/u.test(v.ruleId)) found.add(s.layer, { ...v, ruleId: `patch.${v.ruleId.slice(6)}` }, id, `op${i}`, { opIndex: i });
        Object.assign(s, Object.fromEntries(Object.entries(op.pen).filter(([, v]) => v !== undefined)));
      }
    } else if (op.op === 'modify' && Number.isFinite(op.set.height)) {
      const s = state.get(op.id);
      if (s?.kind === 'text') for (const v of violations({ kind: 'text', height: op.set.height }, ctxOf(s.layer), profile, opts)) if (v.ruleId === 'layer.text-height') found.add(s.layer, { ...v, ruleId: 'patch.text-height' }, op.id, `op${i}`, { opIndex: i });
    }
  });
  const findings = found.done();
  const fixable = new Set(corrections.map(c => c.opIndex));
  const bad = findings.filter(f => f.severity !== 'info');
  const verdict = !bad.length ? 'ok' : bad.every(f => f.suggestedLayer && fixable.has(f.opIndex)) ? 'correctable'
    : bad.some(f => f.severity === 'error') ? 'reject' : 'review';
  // Deduplicate corrections per op/path; the first (kind-driven) suggestion wins.
  const seen = new Set(), uniq = corrections.filter(c => { const k = `${c.opIndex}|${c.path}`; return seen.has(k) ? false : (seen.add(k), true); });
  return { verdict, findings, summary: summarize(findings), suggestions, corrections: uniq };
}

/** Apply `corrections` from checkPatchLayers to a copy of the ops (add.entity.layer / setLayer.layer only). */
export function applyLayerCorrections(ops, corrections) {
  const next = structuredClone(ops);
  for (const c of corrections) {
    const op = next[c.opIndex];
    if (!op) fail('E_LAYER_PROFILE_INPUT', `opIndex=${c.opIndex}`);
    if (op.op === 'add' && c.path === 'entity.layer') op.entity.layer = c.to;
    else if (op.op === 'setLayer' && c.path === 'layer') op.layer = c.to;
    else fail('E_LAYER_PROFILE_INPUT', `correction ${c.opIndex}.${c.path}`);
  }
  return next;
}
