// node tools/generate-plan.mjs spec.json out.jww [--png out.png] [--report out.json] [--zoom out-zoom.png x1,y1,x2,y2] [--no-dll]
// Draws a plan from a spec (generator/draw-plan.mjs), renders it with tools/render-png.mjs (A3 sheet bbox),
// evaluates it (generator/evaluate.mjs) and re-opens it in the JwwHelper DLL reader (native/jww.mjs) to compare entity counts.
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { drawPlan } from '../generator/draw-plan.mjs';
import { evaluatePlan, loadRules } from '../generator/evaluate.mjs';
import { readJww } from '../native/jww.mjs';

const args = process.argv.slice(2), [specPath, outPath] = args, opt = {};
for (let i = 2; i < args.length; i++) {
  const k = args[i].replace(/^--/u, '');
  if (k === 'no-dll') opt[k] = true; else if (k === 'zoom') { opt.zoom = [args[++i], args[++i]]; } else opt[k] = args[++i];
}
if (!specPath || !outPath) { console.error('usage: generate-plan.mjs spec.json out.jww [--png out.png] [--report out.json] [--zoom out.png x1,y1,x2,y2] [--no-dll]'); process.exit(2); }
const render = (jww, png, bbox, extra = []) => promisify(execFile)(process.execPath, [fileURLToPath(new URL('./render-png.mjs', import.meta.url)), jww, png, '--bbox', bbox, ...extra], { windowsHide: true, timeout: 300000 });

try {
  const spec = JSON.parse(await readFile(specPath, 'utf8'));
  const result = drawPlan(spec);
  await writeFile(outPath, result.bytes);
  const report = { spec: path.basename(specPath), output: path.resolve(outPath), bytes: result.bytes.length, entities: result.doc.entities.length, layout: result.layout, warnings: result.warnings };
  report.evaluation = evaluatePlan(result.bytes, spec, await loadRules());
  if (!opt['no-dll']) {
    try {
      const native = await readJww(result.bytes);
      report.dll = { ok: native.entities.length === result.doc.entities.length, entities: native.entities.length, codecEntities: result.doc.entities.length };
    } catch (error) { report.dll = { ok: false, error: error.code ?? error.message }; }
  }
  if (opt.png) { await render(outPath, opt.png, '-210,-148.5,210,148.5', ['--max', opt.max ?? '2400']); report.png = path.resolve(opt.png); }
  if (opt.zoom) { await render(outPath, opt.zoom[0], opt.zoom[1], ['--max', '1800']); report.zoom = path.resolve(opt.zoom[0]); }
  if (opt.report) await writeFile(opt.report, JSON.stringify(report, null, 2) + '\n');
  const e = report.evaluation;
  console.log(JSON.stringify({ output: report.output, entities: report.entities, score: e.score, drafting: e.subscores.drafting, planning: e.subscores.planning,
    errors: e.findings.filter(f => f.severity === 'error').length, warns: e.findings.filter(f => f.severity === 'warn').length, dll: report.dll ?? null, warnings: result.warnings }));
} catch (error) {
  console.error(error.code === 'E_SPEC' ? `E_SPEC\n- ${error.details.join('\n- ')}` : error.stack ?? error.message);
  process.exitCode = 1;
}
