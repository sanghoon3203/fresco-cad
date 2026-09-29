import { readFile, writeFile } from 'node:fs/promises';
import { readJww } from '../native/jww.mjs';
import { toIR } from '../native/jww-pipeline.mjs';
import { prepareArchitectureSkill } from '../ai/architecture-skills.mjs';
const [input, optionsFile, output] = process.argv.slice(2);
try {
  if (!input || !optionsFile || !output) throw new Error('Usage: node tools/prepare-skill.mjs drawing.jww options.json packet.json');
  const bytes = await readFile(input), document = await readJww(bytes);
  const bundle = await prepareArchitectureSkill(toIR(bytes, document), JSON.parse(await readFile(optionsFile, 'utf8')));
  await writeFile(output, JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ skill: bundle.skillId, selected: bundle.context.selection.length, expanded: bundle.context.expandedEntities.length }));
} catch (error) { console.error(error.code ?? error.message); process.exitCode = 1; }
