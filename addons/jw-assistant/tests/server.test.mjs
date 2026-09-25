import test from 'node:test';
import assert from 'node:assert/strict';
import { previewServer } from '../tools/serve.mjs';

test('preview serves only review assets and rejects writes/cross-origin requests', async () => {
  const server = previewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const root = await fetch(`${origin}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/ui/');
    const html = await fetch(`${origin}/ui/`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /type="module"/);
    assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
    const importer = await fetch(`${origin}/jw-adapter/importer.mjs`);
    assert.equal(importer.status, 200);
    assert.match(await importer.text(), /export async function importJwcTemp/);
    const verifier = await fetch(`${origin}/jw-adapter/capture-bundle.mjs`);
    assert.equal(verifier.status, 200);
    assert.match(await verifier.text(), /export async function verifyCapturePair/);
    assert.equal((await fetch(`${origin}/review/store.mjs`)).status, 200);
    assert.equal((await fetch(`${origin}/review/export.mjs`)).status, 200);
    for (const asset of ['/field/standards.mjs','/storage/local-store.mjs','/ui/field-panel.mjs']) assert.equal((await fetch(`${origin}${asset}`)).status, 200);
    assert.equal((await fetch(`${origin}/field/workspace.json`)).status, 404);
    assert.equal((await fetch(`${origin}/review/workspace.json`)).status, 404);
    assert.equal((await fetch(`${origin}/metadata.json`)).status, 404);
    assert.equal((await fetch(`${origin}/bridge/session.json`)).status, 404);
    assert.equal((await fetch(`${origin}/fixtures/jwc-temp/jw-10.3.6-line-10000-shift-jis.txt`)).status, 404);
    const fixture = await fetch(`${origin}/fixtures/timber-plan.json`);
    assert.equal((await fixture.json()).units, 'mm');
    assert.equal((await fetch(`${origin}/CONTRACT.md`)).status, 404);
    assert.equal((await fetch(`${origin}/bridge/Capture-JwTemp.ps1`)).status, 404);
    assert.equal((await fetch(`${origin}/ui/%2e%2e%2f%2e%2e%2fREADME.md`)).status, 404);
    assert.equal((await fetch(`${origin}/ui/`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${origin}/ui/`, { headers: { Origin: 'https://example.invalid' } })).status, 403);
    const head = await fetch(`${origin}/ui/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
