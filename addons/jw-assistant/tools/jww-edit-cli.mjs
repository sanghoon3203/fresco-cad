import { readFile, writeFile, access } from 'node:fs/promises';
import { applyPatchV2, probeRewriteSafety } from '../native/jww-edit.mjs';

const args = process.argv.slice(2), at = args.indexOf('--writer');
const writer = at < 0 ? 'codec' : args.splice(at, 2)[1];
const [command, input, patchPath, output, ...extra] = args;
const usage = 'Usage: node tools/jww-edit-cli.mjs apply-v2 input.jww patch.json output.jww [--writer codec|dll] | probe input.jww [--writer codec|dll]';
try {
  if (extra.length || !input || (command === 'apply-v2' ? !patchPath || !output : command !== 'probe' || patchPath)) throw Object.assign(new Error(usage), { code: 'E_USAGE', detail: usage });
  const bytes = await readFile(input);
  if (command === 'probe') console.log(JSON.stringify(await probeRewriteSafety(bytes, { writer }), null, 2));
  else {
    if (await access(output).then(() => true, () => false)) throw Object.assign(new Error('output exists'), { code: 'E_OUTPUT_EXISTS', detail: output });
    const result = await applyPatchV2(bytes, JSON.parse(await readFile(patchPath, 'utf8')), { writer });
    await writeFile(output, result.bytes, { flag: 'wx' });
    console.log(JSON.stringify(result.receipt, null, 2));
  }
} catch (error) { console.error(error.code ? `${error.code}${error.detail ? `: ${error.detail}` : ''}` : error.message); process.exitCode = 1; }
