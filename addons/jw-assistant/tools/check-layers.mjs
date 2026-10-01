import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, readJww } from '../native/jww.mjs';
import { toIR } from '../native/jww-pipeline.mjs';
import { checkLayers } from '../core/layer-profile.mjs';

// Usage: node tools/check-layers.mjs check <file.jww> [--profile knowledge/office-layer-profile.json] [--fail-on error|warning] [--grid-chain]
// --grid-chain: require 一点鎖線 (styles 4,5) for grid lines instead of the profile's learned grid line types.
const [command, file, ...rest] = process.argv.slice(2);
const opt = name => { const i = rest.indexOf(name); return i < 0 ? undefined : rest[i + 1]; };
const usage = 'Usage: node tools/check-layers.mjs check <file.jww> [--profile knowledge/office-layer-profile.json] [--fail-on error|warning] [--grid-chain]';
if (command !== 'check' || !file) { console.error(usage); process.exit(2); }
const profilePath = path.resolve(opt('--profile') ?? fileURLToPath(new URL('../knowledge/office-layer-profile.json', import.meta.url)));
try {
  const profile = JSON.parse(await readFile(profilePath, 'utf8')), bytes = await readFile(file);
  const ir = toIR(bytes, await readJww(bytes)), result = checkLayers(ir, profile, rest.includes('--grid-chain') ? { gridStyles: [4, 5] } : {});
  const lines = [`${path.basename(file)} (${hash(bytes).slice(0, 12)}) x ${path.basename(profilePath)} (${profile.drawingCount} drawings)`,
    `entities ${result.checkedEntities} · error ${result.summary.error} · warning ${result.summary.warning} · info ${result.summary.info}`,
    ...result.findings.slice(0, 30).map(f => `[${f.severity}] ${f.ruleId} ${f.layerId} x${f.count}: ${f.message_ja}`)];
  if (result.findings.length > 30) lines.push(`... ${result.findings.length - 30} more (see JSON)`);
  console.log(lines.join('\n'));
  console.log(JSON.stringify({ file: path.basename(file), sourceHash: ir.sourceHash, profile: path.basename(profilePath), ...result }, null, 2));
  const failOn = opt('--fail-on');
  if (failOn && result.summary.error + (failOn === 'warning' ? result.summary.warning : 0) > 0) process.exitCode = 1;
} catch (error) { console.error(error.code ?? error.message); process.exitCode = 1; }
