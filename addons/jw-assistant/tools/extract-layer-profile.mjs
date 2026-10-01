import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { hash, readJww } from '../native/jww.mjs';
import { observeDrawing, buildProfile, assignLayerRole, ROLES, LINE_TYPES } from '../core/layer-profile.mjs';

// Usage: node tools/extract-layer-profile.mjs <folder> <out.json> [--report <dir>] [--min-support N] [--max-files N] [--keep-samples]
const args = process.argv.slice(2), flags = {}, positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--keep-samples') flags.keepSamples = true;
  else if (['--report', '--min-support', '--max-files'].includes(args[i])) flags[args[i].slice(2)] = args[++i];
  else positional.push(args[i]);
}
const [root, out] = positional;
if (!root || !out || positional.length > 2) { console.error('Usage: node tools/extract-layer-profile.mjs <folder> <out.json> [--report <dir>] [--min-support N] [--max-files N] [--keep-samples]'); process.exit(2); }
const maxFiles = Number(flags['max-files'] ?? 500), minSupport = Number(flags['min-support'] ?? 2), MAX_DEPTH = 8;
const AUTOSAVE = /\.jw\$|^【自動保存】|\.bak$/iu;
const files = [], skipped = [];
async function walk(folder, depth) {
  if (depth > MAX_DEPTH) { skipped.push({ path: folder, reason: 'depth' }); return; }
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); } catch (error) { skipped.push({ path: folder, reason: error.code }); return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) await walk(full, depth + 1);
    else if (entry.isFile() && /\.jww$/iu.test(entry.name)) {
      if (AUTOSAVE.test(entry.name)) skipped.push({ path: path.relative(root, full), reason: 'autosave/backup' });
      else if (files.length >= maxFiles) skipped.push({ path: path.relative(root, full), reason: 'max-files' });
      else files.push(full);
    }
  }
}
await walk(path.resolve(root), 0);
const observations = [], seen = new Map();
for (const file of files) {
  const name = path.relative(path.resolve(root), file).split(path.sep).join('/');
  try {
    const bytes = await readFile(file), sha256 = hash(bytes);
    if (seen.has(sha256)) { skipped.push({ path: name, reason: `duplicate of ${seen.get(sha256)}` }); continue; }
    seen.set(sha256, name);
    observations.push(observeDrawing(await readJww(bytes), { name, sourceHash: sha256 }));
    console.log(`ok   ${name} (${observations.at(-1).counts.topLevel} entities)`);
  } catch (error) { skipped.push({ path: name, reason: error.code ?? error.message }); console.log(`skip ${name} ${error.code ?? error.message}`); }
}
if (!observations.length) { console.error('E_LAYER_PROFILE_EMPTY: no readable .jww files'); process.exit(1); }
const profile = buildProfile(observations, { minSupport, keepSamples: !!flags.keepSamples });
await mkdir(path.dirname(path.resolve(out)), { recursive: true });
await writeFile(out, JSON.stringify(profile, null, 2) + '\n');
console.log(JSON.stringify({ drawings: profile.drawingCount, roles: Object.keys(profile.roles).length, layers: Object.keys(profile.layers).length, skipped: skipped.length, out }));

if (flags.report) {
  await mkdir(flags.report, { recursive: true });
  const esc = v => String(v ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
  const hist = h => Object.entries(h ?? {}).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(' ') || '—';
  const md = ['# 레이어 컨벤션 프로파일 추출 보고', '', `대상: ${path.resolve(root)} · 도면 ${profile.drawingCount}개 · minSupport ${minSupport} (유효 ${profile.params.effectiveMinSupport})`,
    '이 보고서는 샘플 문자열을 포함하므로 `outputs/` 아래(미추적)에만 둔다. 커밋 대상 프로파일에는 샘플이 없다.', '', '## 집계 역할 표', '',
    '| 역할 | 근거 도면수 | 신뢰도 | 레이어(근거 수) | 펜색 | 선종 | 문자 높이 |', '|---|---:|---:|---|---|---|---|',
    ...Object.entries(profile.roles).map(([id, r]) => `| ${esc(`${r.ja} (${id})`)} | ${r.support} | ${r.confidence} | ${esc(r.layers.slice(0, 6).map(l => `${l.layerId}${l.names[0] ? `「${l.names[0].name.trim()}」` : ''}×${l.support}`).join(', ') || '—')} | ${esc(hist(r.hist.colors))} | ${esc(Object.entries(r.hist.styles).slice(0, 5).map(([k, v]) => `${LINE_TYPES[k]?.[0] ?? k}:${v}`).join(' ') || '—')} | ${esc(hist(r.hist.textHeights))} |`),
    '', `도면 유형 후보 분포: ${JSON.stringify(profile.drawingTypes)}`, '', '## 도면별 요약', ''];
  for (const o of observations) {
    md.push(`### ${o.name}`, '', `sha256 ${o.sourceHash?.slice(0, 12)} · 최상위 ${o.counts.topLevel} · 블록 내부 ${o.counts.blockChildren} · 사용 레이어 ${o.layers.filter(l => l.count).length}`,
      `유형 후보(휴리스틱): ${o.drawingType.candidates.map(c => `${c.ja} ${c.confidence} [${c.evidence.join('; ')}]`).join(' / ') || '불명'}`, '',
      '| 레이어 | 이름 | 축척 | 객체 | 종류(최상위) | 역할(신뢰도) | 근거 | 샘플 문자 |', '|---|---|---:|---:|---|---|---|---|');
    for (const l of o.layers) {
      const a = assignLayerRole(l);
      md.push(`| ${l.id} | ${esc(l.name.trim())} | ${l.scale ?? '—'} | ${l.top.count}+${l.child.count} | ${esc(hist(l.top.kinds))} | ${esc(`${ROLES[a.role].ja} ${a.confidence}`)} | ${esc(a.evidence.join('; '))} | ${esc(l.text.samples.join(' / '))} |`);
    }
    md.push('');
  }
  md.push('## 제외된 파일', '', ...(skipped.length ? skipped.map(s => `- ${s.path}: ${s.reason}`) : ['없음']), '');
  await writeFile(path.join(flags.report, 'layer-profile-report.md'), md.join('\n'));
  await writeFile(path.join(flags.report, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
  console.log(`report: ${path.join(flags.report, 'layer-profile-report.md')}`);
}
