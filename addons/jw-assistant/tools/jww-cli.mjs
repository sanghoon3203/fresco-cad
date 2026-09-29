import { readFile, writeFile } from 'node:fs/promises';
import { readJww } from '../native/jww.mjs';
import { toIR, applyJwwPatch } from '../native/jww-pipeline.mjs';

const [command, input, arg, output, ...extra] = process.argv.slice(2);
try {
  if (extra.length || !input || !arg || !['inspect', 'apply'].includes(command)
      || (command === 'apply' ? !output : !!output)) {
    throw new Error('Usage: node tools/jww-cli.mjs inspect input.jww output.json | apply input.jww patch.json output.jww');
  }
  const bytes = await readFile(input);
  if (command === 'inspect') {
    const ir = toIR(bytes, await readJww(bytes));
    await writeFile(arg, JSON.stringify(ir, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ entities: ir.entities.length, editable: ir.entities.filter(e => e.editable).length, sourceHash: ir.sourceHash }));
  } else {
    const result = await applyJwwPatch(bytes, JSON.parse(await readFile(arg, 'utf8')));
    await writeFile(output, result.bytes, { flag: 'wx' });
    console.log(JSON.stringify(result.receipt, null, 2));
  }
} catch (error) { console.error(error.code ?? error.message); process.exitCode = 1; }
