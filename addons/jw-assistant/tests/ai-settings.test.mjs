import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, resolveSettings, loadSettings, saveSettings, getApiKey, anthropicBaseUrl, openaiBaseUrl, checkDataPolicy,
  createRedactor, restorePatch, scrubSecrets, scrubObject, estimateCost, postJson, expandEnvPath, defaultSettingsPath } from '../ai/settings.mjs';

const code = c => e => e.code === c;
const FAKE = 'sk-ant-api03-TESTKEY-not-a-real-key-0123456789';

test('defaults: real drawings are sent, claude opus default, three attempts, experience outside the repo', () => {
  const s = resolveSettings({}, { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' });
  assert.equal(s.dataPolicy.sendRealDrawings, true);
  assert.equal(s.dataPolicy.redactText, false);
  assert.equal(s.providers.default, 'claude');
  assert.equal(s.providers.claude.model, 'claude-opus-5-5');
  assert.equal(s.providers.claude.fastModel, 'claude-sonnet-5-5');
  assert.equal(typeof s.providers.openai.model, 'string');
  assert.equal(s.loop.maxAttempts, 3);
  assert.equal(s.experience.resolvedDir, path.normalize('C:\\Users\\x\\AppData\\Local/FrescoJw/experience'));
  assert.equal(defaultSettingsPath({ APPDATA: 'C:\\R' }), path.normalize('C:\\R/FrescoJw/settings.json'));
  assert.ok(!JSON.stringify(DEFAULT_SETTINGS).match(/temperature/u), 'no sampling parameters are configured');
  assert.throws(() => resolveSettings({ loop: { maxAttempts: 0 } }), code('E_AI_SETTINGS'));
  assert.throws(() => resolveSettings({ providers: { default: 'gemini' } }), code('E_AI_SETTINGS'));
  assert.equal(expandEnvPath('%NOPE%/x', {}), path.normalize('/x'));
});

test('settings load/save round-trip strips any secret-looking field and never persists keys', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fresco-ai-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  assert.equal((await loadSettings({ file })).providers.default, 'claude', 'missing file → defaults');
  await saveSettings({ ...resolveSettings({}), apiKey: FAKE, providers: { ...DEFAULT_SETTINGS.providers, claude: { ...DEFAULT_SETTINGS.providers.claude, api_key: FAKE } },
    dataPolicy: { sendRealDrawings: false, redactText: true, allowlistHashes: [] } }, { file });
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes(FAKE) && !/api_?key/iu.test(raw));
  const loaded = await loadSettings({ file });
  assert.equal(loaded.dataPolicy.sendRealDrawings, false);
  assert.equal(loaded.dataPolicy.redactText, true);
  await writeFile(file, JSON.stringify({ openaiApiKey: FAKE, loop: { maxAttempts: 2 } }));
  const merged = await loadSettings({ file });
  assert.equal(merged.loop.maxAttempts, 2);
  assert.ok(!JSON.stringify(merged).includes(FAKE));
});

test('API keys come only from env vars; FRESCO_ANTHROPIC_BASE_URL is used and ANTHROPIC_BASE_URL is ignored', () => {
  assert.equal(getApiKey('claude', { ANTHROPIC_API_KEY: ` ${FAKE} ` }), FAKE);
  assert.throws(() => getApiKey('claude', {}), code('E_AI_KEY_REQUIRED'));
  assert.throws(() => getApiKey('openai', { ANTHROPIC_API_KEY: FAKE }), code('E_AI_KEY_REQUIRED'));
  assert.equal(anthropicBaseUrl({ ANTHROPIC_BASE_URL: 'https://proxy.example' }), 'https://api.anthropic.com');
  assert.equal(anthropicBaseUrl({ FRESCO_ANTHROPIC_BASE_URL: 'https://gw.example/anthropic/' }), 'https://gw.example/anthropic');
  assert.equal(anthropicBaseUrl({ FRESCO_ANTHROPIC_BASE_URL: 'http://localhost:8787' }), 'http://localhost:8787');
  assert.throws(() => anthropicBaseUrl({ FRESCO_ANTHROPIC_BASE_URL: 'http://evil.example' }), code('E_AI_SETTINGS'));
  assert.equal(openaiBaseUrl({}), 'https://api.openai.com');
});

test('scrubbing removes key values, bearer tokens and auth headers', () => {
  const env = { ANTHROPIC_API_KEY: FAKE, OPENAI_API_KEY: 'sk-proj-ABCDEFGHIJKLMNOP' };
  const s = scrubSecrets(`x-api-key ${FAKE} Authorization: Bearer abc.def sk-proj-ABCDEFGHIJKLMNOP`, env);
  assert.ok(!s.includes(FAKE) && !s.includes('abc.def') && !s.includes('sk-proj-ABCDEFGHIJKLMNOP'));
  const o = scrubObject({ headers: { 'x-api-key': FAKE, authorization: 'Bearer z' }, note: `key=${FAKE}`, list: [FAKE] }, env);
  assert.deepEqual(o, { headers: {}, note: 'key=[REDACTED]', list: ['[REDACTED]'] });
});

test('data policy: sendRealDrawings=false blocks non-allowlisted files unless redactText=true', () => {
  const hash = 'a'.repeat(64), other = 'b'.repeat(64);
  assert.deepEqual(checkDataPolicy(resolveSettings({}), other), { allowed: true, mode: 'real', redact: false });
  const off = resolveSettings({ dataPolicy: { sendRealDrawings: false, redactText: false, allowlistHashes: [hash] } });
  assert.equal(checkDataPolicy(off, hash).mode, 'allowlisted');
  assert.throws(() => checkDataPolicy(off, other), code('E_AI_DATA_POLICY'));
  const redacted = resolveSettings({ dataPolicy: { sendRealDrawings: false, redactText: true } });
  assert.deepEqual(checkDataPolicy(redacted, other), { allowed: true, mode: 'redacted', redact: true });
  assert.throws(() => resolveSettings({ dataPolicy: { allowlistHashes: ['not-a-hash'] } }), code('E_AI_SETTINGS'));
});

test('redaction round-trip: identical strings share a placeholder and patches map back', () => {
  const r = createRedactor();
  const a = r.redact('洋室'), b = r.redact('Ａ様邸 新築工事'), a2 = r.redact('洋室');
  assert.equal(a, a2);
  assert.notEqual(a, b);
  assert.match(a, /^«T\d+»$/u);
  const patch = { schemaVersion: 2, sourceHash: 'h', units: 'model-mm', rationale: `rename ${a}`, needsClarification: null,
    ops: [{ op: 'modify', id: 'e1', set: { text: `${a}・${b}` } }, { op: 'add', tempId: null, entity: { kind: 'text', text: b } }] };
  const back = restorePatch(patch, r);
  assert.equal(back.ops[0].set.text, '洋室・Ａ様邸 新築工事');
  assert.equal(back.ops[1].entity.text, 'Ａ様邸 新築工事');
  assert.equal(back.rationale, 'rename 洋室');
  assert.equal(patch.ops[0].set.text, `${a}・${b}`, 'input patch is not mutated');
  assert.equal(r.restore('«T99»'), '«T99»', 'unknown placeholders are left alone');
});

test('approximate cost estimate uses the single pricing table', () => {
  const usage = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 0, requests: 3 };
  assert.deepEqual(estimateCost('claude-opus-5-5', usage), { usd: 24.2, approximate: true, model: 'claude-opus-5-5' });
  assert.equal(estimateCost('claude-haiku-4-5-20251001', usage).model, 'claude-haiku-4-5');
  assert.equal(estimateCost('unknown-model', usage).usd, null);
});

test('postJson retries 429 with retry-after, maps errors and never echoes keys', async () => {
  const env = { ANTHROPIC_API_KEY: FAKE };
  const sleeps = [];
  let n = 0;
  const fetcher = async () => (++n === 1
    ? new Response(JSON.stringify({ error: { type: 'rate_limit' } }), { status: 429, headers: { 'retry-after': '2' } })
    : new Response('{"ok":true}', { status: 200 }));
  assert.deepEqual(await postJson('https://x', { headers: {}, body: {}, fetcher, sleep: async ms => sleeps.push(ms), env }), { ok: true });
  assert.deepEqual(sleeps, [2000]);
  const echo = async () => new Response(JSON.stringify({ error: { type: 'authentication_error', message: `invalid x-api-key ${FAKE}` } }), { status: 401 });
  await assert.rejects(postJson('https://x', { headers: {}, body: {}, fetcher: echo, env }), e => e.code === 'E_AI_HTTP_401' && !e.message.includes(FAKE) && e.message.includes('[REDACTED]'));
  const timeout = async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
  await assert.rejects(postJson('https://x', { headers: {}, body: {}, fetcher: timeout, env }), code('E_AI_TIMEOUT'));
  await assert.rejects(postJson('https://x', { headers: {}, body: {}, fetcher: async () => new Response('not json'), env }), code('E_AI_RESPONSE'));
});
