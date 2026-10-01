// node tools/render-png.mjs <in.jww> <out.png> [--layers 1:5,1:6] [--groups 1] [--bbox x1,y1,x2,y2] [--px-per-mm 4] [--max 2400]
// Decodes with the pure-JS codec, flattens to paper-mm primitives, rasterizes via tools/render-png.ps1 (System.Drawing).
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { decodeJww, semanticView } from '../native/codec/jww-codec.mjs';
import { flattenDrawing } from '../native/render/flatten.mjs';

const [input, output, ...rest] = process.argv.slice(2);
if (!input || !output) { console.error('usage: render-png.mjs <in.jww> <out.png> [--layers ..] [--groups ..] [--bbox ..] [--px-per-mm n] [--max px]'); process.exit(2); }
const opt = {}; for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/u, '')] = rest[i + 1];
const view = semanticView(decodeJww(await readFile(input)));
const flat = flattenDrawing(view, { layers: opt.layers?.split(','), groups: opt.groups?.split(',') });
const bbox = opt.bbox ? opt.bbox.split(',').map(Number) : flat.bbox;
if (!bbox) { console.error('E_RENDER_EMPTY'); process.exit(1); }
const folder = await mkdtemp(path.join(tmpdir(), 'fresco-render-'));
try {
  const json = path.join(folder, 'scene.json');
  await writeFile(json, JSON.stringify({ bbox, pxPerMm: Number(opt['px-per-mm'] ?? 0), maxPx: Number(opt.max ?? 2400), primitives: flat.primitives }));
  await promisify(execFile)(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./render-png.ps1', import.meta.url)), '-ScenePath', json, '-OutputPath', path.resolve(output)],
    { windowsHide: true, timeout: 180000, maxBuffer: 1 << 20 });
  console.log(JSON.stringify({ output: path.resolve(output), bbox, counts: flat.counts }));
} finally { await rm(folder, { recursive: true, force: true }); }
