// Audit the pure-JS JWW codec over a folder: decode, byte-exact round trip, semantic match vs the native DLL reader.
// Usage: node tools/codec-audit.mjs <input-dir> <report-dir> [--ext jww,jw$,bak] [--no-native]
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decodeJww, encodeJww, SPAN } from '../native/codec/jww-codec.mjs';
import { compareWithNative } from '../native/codec/compare.mjs';

const args = process.argv.slice(2), flags = new Set(args.filter(a => a.startsWith('--') && !a.includes('=')));
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const [root, destination] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--ext');
if (!root || !destination) { console.error('Usage: node tools/codec-audit.mjs <input-dir> <report-dir> [--ext jww,jw$,bak] [--no-native]'); process.exit(2); }
const repo = path.resolve(fileURLToPath(new URL('../../..', import.meta.url))), out = path.resolve(destination), input = path.resolve(root);
const inside = (child, parent) => { const r = path.relative(parent, child); return !r.startsWith('..') && !path.isAbsolute(r); };
if ((inside(out, repo) && !inside(out, path.join(repo, 'outputs'))) || inside(out, input)) { console.error('E_AUDIT_OUTPUT: report dir must be outside the repo (or under outputs/) and outside the input dir'); process.exit(2); }
const extensions = (option('--ext') ?? 'jww').split(',').map(e => e.trim().toLowerCase().replace(/^\./u, ''));
const readJww = flags.has('--no-native') ? null : (await import('../native/jww.mjs')).readJww;

const files = [];
async function walk(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const name = path.join(folder, entry.name);
    if (entry.isDirectory()) await walk(name);
    else if (entry.isFile() && extensions.includes(path.extname(entry.name).slice(1).toLowerCase())) files.push(name);
  }
}
await walk(input);
files.sort();

// Name the record that contains a differing offset, for triage.
function locate(doc, offset) {
  for (const [section, [s, e]] of Object.entries(doc.spans)) if (offset >= s && offset < e) {
    const list = section === 'entities' ? doc.entities : section === 'blocks' ? doc.blocks : [];
    for (const item of list) {
      const [a, b] = item[SPAN];
      if (offset >= a && offset < b) return `${section}:${item.children?.find(c => offset >= c[SPAN][0] && offset < c[SPAN][1])?.id ?? item.id}`;
    }
    return section;
  }
  return 'trailer';
}

const rows = [];
for (const file of files) {
  const row = { file: path.relative(input, file), decode: false, byteExact: false, semantic: null };
  const started = performance.now();
  try {
    const bytes = await readFile(file);
    Object.assign(row, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    const doc = decodeJww(bytes);
    Object.assign(row, { version: doc.version, decode: !doc.partial, partial: doc.partial ?? null, entities: doc.entities.length, blocks: doc.blocks.length,
      images: doc.images?.length ?? null, classes: doc.schemas, stringEncoding: doc.stringEncoding, diagnostics: doc.diagnostics.slice(0, 20) });
    const encoded = encodeJww(doc);
    row.byteExact = encoded.equals(bytes);
    if (!row.byteExact) {
      let i = 0; while (i < bytes.length && i < encoded.length && bytes[i] === encoded[i]) i++;
      Object.assign(row, { firstDiff: i, firstDiffAt: locate(doc, i), encodedBytes: encoded.length });
    }
    if (readJww) {
      try { const r = compareWithNative(doc, await readJww(bytes)); row.semantic = { ok: r.ok, mismatchCount: r.mismatchCount, mismatches: r.mismatches.slice(0, 5), noteCount: r.noteCount, notes: r.notes.slice(0, 3) }; }
      catch (error) { row.semantic = { ok: false, error: error.code ?? error.message }; }
    }
  } catch (error) { row.error = error.code ?? error.message; }
  row.ms = Math.round(performance.now() - started);
  rows.push(row);
  console.log(`${row.byteExact ? 'OK  ' : 'FAIL'} ${row.file} v${row.version ?? '?'} semantic=${row.semantic?.ok ?? '-'}${row.error ? ` ${row.error}` : ''}`);
}

const summary = { generatedAt: new Date().toISOString(), input, extensions, files: rows.length, decoded: rows.filter(r => r.decode).length,
  byteExact: rows.filter(r => r.byteExact).length, semanticOk: rows.filter(r => r.semantic?.ok).length, nativeChecked: !!readJww };
await mkdir(out, { recursive: true });
await writeFile(path.join(out, 'codec-audit.json'), JSON.stringify({ summary, rows }, null, 2));
const md = [`# JWW codec audit`, '', `${summary.generatedAt} · ${summary.files} files · decode ${summary.decoded} · byte-exact ${summary.byteExact} · semantic ${readJww ? summary.semanticOk : 'not checked'}`, '',
  '| file | ver | decode | byte-exact | semantic | entities | blocks | first diff | notes |', '|---|---|---|---|---|---|---|---|---|',
  ...rows.map(r => `| ${r.file} | ${r.version ?? ''} | ${r.decode ? 'ok' : 'FAIL'} | ${r.byteExact ? 'ok' : 'FAIL'} | ${r.semantic ? (r.semantic.ok ? 'ok' : `FAIL ${r.semantic.mismatchCount ?? r.semantic.error}`) : '-'} | ${r.entities ?? ''} | ${r.blocks ?? ''} | ${r.firstDiff !== undefined ? `${r.firstDiff} (${r.firstDiffAt})` : ''} | ${[r.error, r.partial?.message, r.semantic?.noteCount ? `${r.semantic.noteCount} native-lossy strings` : ''].filter(Boolean).join('; ')} |`)].join('\n');
await writeFile(path.join(out, 'codec-audit.md'), md + '\n');
console.log(`report: ${out}`);
process.exitCode = summary.byteExact === summary.files ? 0 : 1;
