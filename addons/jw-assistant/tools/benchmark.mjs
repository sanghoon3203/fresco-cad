import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { checkSnapshot } from '../core/engine.mjs';

const snapshot = { schemaVersion: 1, documentId: 'sparse-synthetic-10k', revision: 1, units: 'mm', entities: [] };
for (let n = 0; n < 10000; n++) {
  const x = n % 100 * 100;
  const y = Math.floor(n / 100) * 100;
  snapshot.entities.push({ id: `line-${n}`, kind: 'line', layer: 'WALL', color: 'default', lineType: 'solid', start: [x, y], end: [x + 50, y] });
}
checkSnapshot(snapshot);
const samplesMs = [];
for (let run = 0; run < 30; run++) {
  const start = performance.now();
  const issues = checkSnapshot(snapshot);
  samplesMs.push(performance.now() - start);
  if (issues.length) throw new Error('Unexpected sparse fixture finding');
}
samplesMs.sort((a, b) => a - b);
console.log(JSON.stringify({
  measuredAt: new Date().toISOString(), node: process.version, os: `${os.platform()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model, fixture: snapshot.documentId, entities: 10000, runs: 30,
  p50Ms: samplesMs[14], p95Ms: samplesMs[28], maxMs: samplesMs[29],
  limitations: 'Sparse synthetic line-only check CPU time. Not JWW import, dense geometry, UI latency, or Jw_cad integration performance.'
}, null, 2));
