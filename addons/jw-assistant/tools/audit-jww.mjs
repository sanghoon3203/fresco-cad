import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { hash, readJww, patchLine } from '../native/jww.mjs';

const [root, destination] = process.argv.slice(2);
if (!root || !destination) throw new Error('Usage: node tools/audit-jww.mjs input-directory report-directory');
const files = [], discoveryErrors = [];
async function walk(folder) {
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); }
  catch (error) { discoveryErrors.push({ path: folder, error: error.code }); return; }
  for (const entry of entries) {
    const name = path.join(folder, entry.name);
    if (entry.isDirectory()) await walk(name);
    else if (entry.isFile() && /\.jww$/i.test(entry.name)) files.push(name);
  }
}
await walk(path.resolve(root));
files.sort();
await mkdir(destination, { recursive: true });
const rows = [];
for (const file of files) {
  const started = Date.now(), row = { file: path.relative(root, file), status: 'FAIL' };
  let source;
  try {
    source = await readFile(file);
    Object.assign(row, { bytes: source.length, sha256: hash(source), magic: source.subarray(0, 8).toString('ascii') });
    const doc = await readJww(source);
    Object.assign(row, { status: 'PASS', version: doc.version, entities: doc.entities.length,
      blockDefinitions: doc.blockDefinitions, images: doc.images, types: {}, eligibleLines: 0, lineRejections: {}, invalidNumbers: 0 });
    for (const entity of doc.entities) {
      row.types[entity.type] = (row.types[entity.type] ?? 0) + 1;
      row.invalidNumbers += Object.values(entity.props).filter(v => typeof v === 'number' && !Number.isFinite(v)).length;
      if (entity.type !== 'JwwSen') continue;
      try {
        const p = entity.props;
        const layer = doc.layers.find(l => l.id === `${p.m_nGLayer.toString(16).toUpperCase()}:${p.m_nLayer.toString(16).toUpperCase()}`);
        if (!Number.isFinite(layer?.scale) || layer.scale <= 0) throw Object.assign(new Error(), { code: 'E_PATCH_SCALE' });
        patchLine(source, doc, entity.id, [p.m_start_x, p.m_start_y, p.m_end_x, p.m_end_y]);
        row.eligibleLines++;
      } catch (error) { const code = error.code ?? 'E_UNKNOWN'; row.lineRejections[code] = (row.lineRejections[code] ?? 0) + 1; }
    }
    try {
      const repeat = await readJww(source);
      row.repeatStable = JSON.stringify(doc) === JSON.stringify(repeat);
      row.changedEntityIds = doc.entities.filter((e, i) => JSON.stringify(e) !== JSON.stringify(repeat.entities[i])).map(e => e.id);
      if (!row.repeatStable || row.invalidNumbers) row.status = 'WARN';
    } catch (error) { row.status = 'WARN'; row.repeatError = error.code ?? error.message; }
  } catch (error) { row.error = error.code ?? error.message; }
  if (source) {
    try { row.sourceUnchanged = hash(await readFile(file)) === row.sha256; }
    catch (error) { row.sourceCheckError = error.code; }
  }
  row.elapsedMs = Date.now() - started;
  rows.push(row);
  console.log(JSON.stringify(row));
  await writeFile(path.join(destination, 'audit.json'), JSON.stringify({ root: path.resolve(root), discoveryErrors, rows }, null, 2));
}
const summary = { files: rows.length, pass: rows.filter(r => r.status === 'PASS').length,
  warn: rows.filter(r => r.status === 'WARN').length, fail: rows.filter(r => r.status === 'FAIL').length,
  withEditableLines: rows.filter(r => r.eligibleLines > 0).length,
  unchanged: rows.filter(r => r.sourceUnchanged).length, discoveryErrors: discoveryErrors.length };
await writeFile(path.join(destination, 'audit.json'), JSON.stringify({ date: new Date().toISOString(), root: path.resolve(root), summary, discoveryErrors, rows }, null, 2));
const escape = value => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
const md = ['# JWW 전체 파싱 검사', '', `대상: ${path.resolve(root)}`, '',
  `파일 ${summary.files}개 · 성공 ${summary.pass} · 경고 ${summary.warn} · 실패 ${summary.fail} · 읽기 전후 해시 동일 ${summary.unchanged}`, '',
  'PASS는 현재 reader로 두 번 읽어 동일한 top-level JSON을 얻었다는 의미다. 전체 정보 보존, Jw_cad 재개방, 수정·저장 성공을 의미하지 않는다.',
  '블록 내부 객체와 내장 이미지 내용은 현재 JSON에 펼쳐지지 않는다. 편집 가능 선은 현재 좌표 patch 조건 검사 결과이며 실제 수정은 수행하지 않았다.', '',
  '| 파일 | 파싱 | 내부 버전 | 객체 수 | 선 수 | 편집 후보 선 | 블록 정의 | 이미지 | 반복 일치 | 오류/제외 이유 |',
  '|---|---|---:|---:|---:|---:|---:|---:|---|---|',
  ...rows.map(r => `| ${[r.file, r.status, r.version, r.entities, r.types?.JwwSen ?? 0, r.eligibleLines, r.blockDefinitions, r.images, r.repeatStable, r.error ?? JSON.stringify(r.lineRejections)].map(escape).join(' | ')} |`), '',
  'E_JWW_LINE_ONLY: 현재 편집 범위 밖(구형 레이아웃 또는 그룹/플래그 속성). E_JWW_AMBIGUOUS_RECORD: 동일 바이트 패턴이 복수이거나 일치 구간 없음. E_PATCH_SCALE: 축척 불명확. 이는 파싱 실패와 별개다.', '',
  `탐색 오류: ${JSON.stringify(discoveryErrors)}`, ''];
await writeFile(path.join(destination, 'report.md'), md.join('\n'));
console.log(JSON.stringify({ summary }));
