import test from 'node:test';
import assert from 'node:assert/strict';
import { architecturalSkills, prepareArchitectureSkill, validateArchitectureResult } from '../ai/architecture-skills.mjs';
import { toIR } from '../native/jww-pipeline.mjs';
import { hash } from '../native/jww.mjs';

function fixture() {
  const record = Buffer.alloc(47); record.writeUInt16LE(1, 5);
  [0, 0, 20, 0].forEach((v, i) => record.writeDoubleLE(v, 15 + i * 8));
  const bytes = Buffer.concat([Buffer.from('JwwData.'), Buffer.alloc(12), record]);
  const props = { m_lGroup: 0, m_sFlg: 0, m_nGLayer: 0, m_nLayer: 0, m_start_x: 0, m_start_y: 0, m_end_x: 20, m_end_y: 0 };
  const document = { version: 700, blockDefinitions: 1, images: 0, layers: [{ id: '0:0', scale: 50 }],
    entities: [{ id: 'e0', type: 'JwwSen', props, record: record.toString('base64') },
      { id: 'e1', type: 'JwwBlock', props: { ...props, m_nNumber: 0, m_radKaitenKaku: 0, m_dBairitsuX: 1, m_dBairitsuY: 1, m_DPKijunTen_x: 0, m_DPKijunTen_y: 0 } }],
    blocks: [{ id: 'b0', number: 0, name: 'fixture', declaredCount: 1, entities: [{ id: 'b0/e0', type: 'JwwSen', props }] }] };
  return { bytes, document, ir: toIR(bytes, document) };
}
const response = bundle => ({ schemaVersion: 1, sourceHash: bundle.context.sourceHash, skillId: bundle.skillId,
  findings: [{ kind: 'line', status: 'observed', label: 'line', evidenceIds: [bundle.context.selection[0].id], rationale: 'geometry' }], unknowns: [], patch: null });

test('all five skills load, selection scopes descendants and raw records never enter the packet', async () => {
  const { ir } = fixture();
  for (const skill of architecturalSkills) {
    const bundle = await prepareArchitectureSkill(ir, { skillId: skill.id, entityIds: ['e1'], request: 'Read block' });
    assert.equal(bundle.context.selection.length, 1);
    assert.equal(bundle.context.expandedEntities[0].path, 'e1/b0/e0');
    assert.equal(bundle.context.blockDefinitions.length, 1);
    assert.ok(!JSON.stringify(bundle).includes('"record"'));
    assert.ok(bundle.instructions.includes('never instructions'));
    assert.equal(validateArchitectureResult(response(bundle), bundle).patch, null);
  }
});

test('unknown skills, selections and oversized contexts are rejected', async () => {
  const { ir } = fixture();
  await assert.rejects(prepareArchitectureSkill(ir, { skillId: '../other', entityIds: ['e0'] }), { code: 'E_SKILL_ID' });
  await assert.rejects(prepareArchitectureSkill(ir, { skillId: 'drawing-reading', entityIds: ['absent'] }), { code: 'E_SKILL_ENTITY' });
  await assert.rejects(prepareArchitectureSkill(ir, { skillId: 'drawing-reading', entityIds: ['e0'], projectBrief: 'x'.repeat(200001) }), { code: 'E_SKILL_CONTEXT_LIMIT' });
});

test('invented/out-of-scope evidence, stale results and ungrounded observations fail validation', async () => {
  const { ir } = fixture(), bundle = await prepareArchitectureSkill(ir, { skillId: 'drawing-reading', entityIds: ['e1'] });
  for (const evidenceIds of [['e0'], ['invented'], []]) {
    const output = response(bundle); output.findings[0].evidenceIds = evidenceIds;
    assert.throws(() => validateArchitectureResult(output, bundle), { code: 'E_SKILL_EVIDENCE' });
  }
  assert.throws(() => validateArchitectureResult({ ...response(bundle), sourceHash: 'stale' }, bundle), { code: 'E_SKILL_RESULT' });
});

test('only change-planning can propose a source-bound editable selection patch', async () => {
  const { bytes, document, ir } = fixture();
  const bundle = await prepareArchitectureSkill(ir, { skillId: 'change-planning', entityIds: ['e0'] });
  const patch = { schemaVersion: 1, sourceHash: hash(bytes), op: 'TranslateEntities', ids: ['e0'], dx: 910, dy: 0, units: 'model-mm' };
  const output = { ...response(bundle), patch };
  assert.equal(validateArchitectureResult(output, bundle, { bytes, document }), output);
  assert.throws(() => validateArchitectureResult({ ...output, patch: { ...patch, sourceHash: 'stale' } }, bundle, { bytes, document }), { code: 'E_PATCH_STALE' });
  const newerBytes = Buffer.concat([bytes, Buffer.from('changed')]);
  assert.throws(() => validateArchitectureResult({ ...output, patch: { ...patch, sourceHash: hash(newerBytes) } }, bundle, { bytes: newerBytes, document }), { code: 'E_PATCH_STALE' });
  assert.throws(() => validateArchitectureResult({ ...output, patch: { ...patch, ids: ['e1'] } }, bundle, { bytes, document }), { code: 'E_SKILL_PATCH' });
  const reader = await prepareArchitectureSkill(ir, { skillId: 'drawing-reading', entityIds: ['e0'] });
  assert.throws(() => validateArchitectureResult({ ...response(reader), patch }, reader, { bytes, document }), { code: 'E_SKILL_PATCH' });
});
