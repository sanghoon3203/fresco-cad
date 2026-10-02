// node tools/generate-set.mjs spec.json outDir [--no-png] [--no-dll] [--only plan,elevation,section,foundation,detail]
// Draws the full drawing set from ONE plan spec + building block: 平面図 1/50, 立面図 4面 1/100, 断面詳細図 1/50,
// 基礎伏図 1/50, 基礎詳細図 1/25. Every sheet is evaluated (generator/evaluate*.mjs), re-encoded with the codec
// (must be byte-identical) and re-opened in the JwwHelper DLL reader (native/jww.mjs) to compare entity counts.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decodeJww, encodeJww } from '../native/codec/jww-codec.mjs';
import { readJww } from '../native/jww.mjs';
import { drawPlan } from '../generator/draw-plan.mjs';
import { evaluatePlan, loadRules } from '../generator/evaluate.mjs';
import { buildBuilding } from '../generator/building.mjs';
import { drawElevations } from '../generator/draw-elevation.mjs';
import { drawSection } from '../generator/draw-section.mjs';
import { drawFoundationPlan, drawFoundationDetails } from '../generator/draw-foundation.mjs';
import { evaluateElevations } from '../generator/evaluate-elevation.mjs';
import { evaluateSection } from '../generator/evaluate-section.mjs';
import { evaluateFoundationPlan, evaluateFoundationDetails } from '../generator/evaluate-foundation.mjs';
import { loadSetRules } from '../generator/evaluate-common.mjs';

const SHEETS = ['plan', 'elevation', 'section', 'foundation', 'detail'];
const render = (jww, png, bbox, extra = []) => promisify(execFile)(process.execPath, [fileURLToPath(new URL('./render-png.mjs', import.meta.url)), jww, png, '--bbox', bbox, ...extra], { windowsHide: true, timeout: 300000 });

/** Generate the set in memory. Returns {building, sheets: {name: {bytes, evaluation, warnings, entities}}}. */
export async function generateSet(spec, { only = SHEETS } = {}) {
  const [planRules, setRules] = await Promise.all([loadRules(), loadSetRules()]);
  const B = buildBuilding(spec), out = {};
  const run = (name, draw, evaluate, rules) => {
    if (!only.includes(name)) return;
    const r = draw();
    out[name] = { bytes: r.bytes, entities: r.doc.entities.length, warnings: r.warnings, info: r.info ?? r.views ?? null, evaluation: evaluate(r.bytes, rules) };
  };
  run('plan', () => drawPlan(spec), bytes => evaluatePlan(bytes, spec, planRules));
  run('elevation', () => drawElevations(spec, { building: B }), bytes => evaluateElevations(bytes, spec, setRules.elevation));
  run('section', () => drawSection(spec, { building: B }), bytes => evaluateSection(bytes, spec, setRules.section));
  run('foundation', () => drawFoundationPlan(spec, { building: B }), bytes => evaluateFoundationPlan(bytes, spec, setRules.foundation));
  run('detail', () => drawFoundationDetails(spec, { building: B }), bytes => evaluateFoundationDetails(bytes, spec, setRules.foundation));
  return { building: B, sheets: out };
}

/** Codec round trip (byte identical) + DLL reader entity count. */
export async function verifySheet(bytes, entities, { dll = true } = {}) {
  const re = encodeJww(decodeJww(bytes)), codec = Buffer.compare(Buffer.from(re), Buffer.from(bytes)) === 0;
  const res = { codecRoundTrip: codec, entities };
  if (dll) {
    try { const n = await readJww(bytes); res.dll = { ok: n.entities.length === entities, entities: n.entities.length }; }
    catch (error) { res.dll = { ok: false, error: error.code ?? error.message }; }
  }
  return res;
}

async function main() {
  const args = process.argv.slice(2), [specPath, outDir] = args, opt = { png: true, dll: true, only: SHEETS };
  for (let i = 2; i < args.length; i++) { if (args[i] === '--no-png') opt.png = false; else if (args[i] === '--no-dll') opt.dll = false; else if (args[i] === '--only') opt.only = args[++i].split(','); }
  if (!specPath || !outDir) { console.error('usage: generate-set.mjs spec.json outDir [--no-png] [--no-dll] [--only plan,elevation,section,foundation,detail]'); process.exit(2); }
  const spec = JSON.parse(await readFile(specPath, 'utf8'));
  await mkdir(outDir, { recursive: true });
  const { building, sheets } = await generateSet(spec, { only: opt.only });
  const summary = { spec: path.basename(specPath), output: path.resolve(outDir), levels: building.levels, roof: { low: building.roof.low, slope: building.roof.slope, max: Math.round(building.roof.maxHeight * 10) / 10, label: building.roof.maxLabel },
    section: building.section, foundation: { interior: building.building.foundation.interior, risers: building.foundation.risers.length, beams: building.foundation.beams.length, manholes: building.foundation.manholes.length, anchors: building.foundation.anchors.length, posts: building.foundation.posts.length }, sheets: {} };
  for (const [name, s] of Object.entries(sheets)) {
    const file = path.join(outDir, `${name}.jww`);
    await writeFile(file, s.bytes);
    const verify = await verifySheet(s.bytes, s.entities, { dll: opt.dll });
    if (opt.png) await render(file, path.join(outDir, `${name}.png`), '-210,-148.5,210,148.5', ['--max', '2400']);
    const e = s.evaluation;
    await writeFile(path.join(outDir, `${name}.report.json`), JSON.stringify({ sheet: name, entities: s.entities, warnings: s.warnings, verify, evaluation: e }, null, 2) + '\n');
    summary.sheets[name] = { score: e.score, drafting: e.subscores.drafting, planning: e.subscores.planning, errors: e.findings.filter(f => f.severity === 'error').length, warns: e.findings.filter(f => f.severity === 'warn').length, entities: s.entities, codec: verify.codecRoundTrip, dll: verify.dll?.ok ?? null };
  }
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary.sheets));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.code === 'E_SPEC' ? `E_SPEC\n- ${error.details.join('\n- ')}` : error.stack ?? error.message); process.exitCode = 1; });
