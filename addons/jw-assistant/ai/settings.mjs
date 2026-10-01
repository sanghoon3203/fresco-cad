// AI edit-loop settings, data policy, secrets hygiene, HTTP transport and the (approximate) pricing table.
// API keys are read ONLY from environment variables at call time. They are never stored in settings, records or errors.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const fail = (code, detail) => { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, detail }); };

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  // User decision (2026-10): real drawings are sent by default; switch off here.
  dataPolicy: { sendRealDrawings: true, redactText: false, allowlistHashes: [] },
  providers: {
    default: 'claude',
    claude: { model: 'claude-opus-5-5', fastModel: 'claude-sonnet-5-5', effort: 'high', maxTokens: 16000, timeoutMs: 180000, refusalFallback: true },
    // OpenAI model ids change often: verify the current id before a live run. Configurable here.
    openai: { model: 'gpt-5.2', reasoningEffort: 'medium', maxOutputTokens: 16000, timeoutMs: 180000 }
  },
  // "Temperatureless": no sampling parameters are ever sent (current Claude models reject them; reasoning models ignore them).
  loop: { maxAttempts: 3, maxToolCalls: 12, httpRetries: 2 },
  experience: { dir: '%LOCALAPPDATA%/FrescoJw/experience', enabled: true }
});

const SECRET_KEY = /(api[-_]?key|secret|token|password|authorization)/iu;
const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, extra) {
  if (!isObject(extra)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(extra)) {
    if (SECRET_KEY.test(k)) continue; // secrets never live in settings
    out[k] = isObject(v) && isObject(base?.[k]) ? merge(base[k], v) : structuredClone(v);
  }
  return out;
}
const stripSecrets = value => Array.isArray(value) ? value.map(stripSecrets)
  : isObject(value) ? Object.fromEntries(Object.entries(value).filter(([k]) => !SECRET_KEY.test(k)).map(([k, v]) => [k, stripSecrets(v)])) : value;

export function expandEnvPath(p, env = process.env) {
  const fallback = { APPDATA: path.join(homedir(), 'AppData', 'Roaming'), LOCALAPPDATA: path.join(homedir(), 'AppData', 'Local') };
  return path.normalize(String(p).replace(/%([A-Z_]+)%/giu, (_, name) => env[name] ?? fallback[name.toUpperCase()] ?? ''));
}
export const defaultSettingsPath = (env = process.env) => expandEnvPath('%APPDATA%/FrescoJw/settings.json', env);

/** Merge partial settings over defaults; validate the values the loop depends on. */
export function resolveSettings(partial = {}, env = process.env) {
  const s = merge(DEFAULT_SETTINGS, partial);
  const { loop, dataPolicy } = s;
  if (!Number.isInteger(loop.maxAttempts) || loop.maxAttempts < 1 || loop.maxAttempts > 10) fail('E_AI_SETTINGS', 'loop.maxAttempts');
  if (!Number.isInteger(loop.maxToolCalls) || loop.maxToolCalls < 0 || loop.maxToolCalls > 60) fail('E_AI_SETTINGS', 'loop.maxToolCalls');
  if (typeof dataPolicy.sendRealDrawings !== 'boolean' || typeof dataPolicy.redactText !== 'boolean' || !Array.isArray(dataPolicy.allowlistHashes)
    || dataPolicy.allowlistHashes.some(h => !/^[0-9a-f]{64}$/u.test(h))) fail('E_AI_SETTINGS', 'dataPolicy');
  if (!['claude', 'claude-fast', 'openai'].includes(s.providers.default)) fail('E_AI_SETTINGS', 'providers.default');
  s.experience.resolvedDir = expandEnvPath(s.experience.dir, env);
  return s;
}

export async function loadSettings({ file = defaultSettingsPath(), env = process.env } = {}) {
  let raw = {};
  try { raw = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') fail('E_AI_SETTINGS', `unreadable ${path.basename(file)}`); }
  return resolveSettings(raw, env);
}

export async function saveSettings(settings, { file = defaultSettingsPath() } = {}) {
  const clean = stripSecrets(structuredClone(settings));
  delete clean.experience?.resolvedDir;
  resolveSettings(clean); // refuse to persist invalid settings
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
  return clean;
}

// ---- secrets -------------------------------------------------------------------------------------------------------
const KEY_ENV = { claude: 'ANTHROPIC_API_KEY', 'claude-fast': 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };
export function getApiKey(provider, env = process.env) {
  const name = KEY_ENV[provider];
  if (!name) fail('E_AI_PROVIDER', provider);
  const key = env[name];
  if (typeof key !== 'string' || !key.trim()) fail('E_AI_KEY_REQUIRED', name);
  return key.trim();
}
// FRESCO_ANTHROPIC_BASE_URL only: ANTHROPIC_BASE_URL belongs to the developer's Claude Code session.
export function anthropicBaseUrl(env = process.env) { return checkedBase(env.FRESCO_ANTHROPIC_BASE_URL || 'https://api.anthropic.com'); }
export function openaiBaseUrl(env = process.env) { return checkedBase(env.FRESCO_OPENAI_BASE_URL || 'https://api.openai.com'); }
function checkedBase(value) {
  let url;
  try { url = new URL(value); } catch { fail('E_AI_SETTINGS', 'base url'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) fail('E_AI_SETTINGS', 'base url must be https');
  return url.origin + url.pathname.replace(/\/+$/u, '');
}
/** Replace any configured key value (and bearer/x-api-key fragments) in a string. */
export function scrubSecrets(text, env = process.env) {
  let out = String(text ?? '');
  for (const name of new Set(Object.values(KEY_ENV))) {
    const key = env[name]?.trim();
    if (key && key.length >= 8) out = out.split(key).join('[REDACTED]');
  }
  return out.replace(/(sk-(?:ant-)?[A-Za-z0-9_-]{8,})/gu, '[REDACTED]').replace(/(Bearer\s+)[^\s"']+/giu, '$1[REDACTED]');
}
/** Deep-scrub an object destined for logs/records. */
export function scrubObject(value, env = process.env) {
  if (typeof value === 'string') return scrubSecrets(value, env);
  if (Array.isArray(value)) return value.map(v => scrubObject(v, env));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).filter(([k]) => !/^(api[-_]?key|x-api-key|authorization)$/iu.test(k)).map(([k, v]) => [k, scrubObject(v, env)]));
  return value;
}

// ---- data policy -----------------------------------------------------------------------------------------------------
/**
 * Decide whether this drawing may be sent to a cloud model.
 * sendRealDrawings=true → allowed (optionally redacted). false → allowlisted synthetic/sample hash, or redactText=true.
 */
export function checkDataPolicy(settings, sourceHash) {
  const p = settings.dataPolicy;
  if (p.sendRealDrawings) return { allowed: true, mode: p.redactText ? 'redacted' : 'real', redact: p.redactText };
  if (p.allowlistHashes.includes(sourceHash)) return { allowed: true, mode: 'allowlisted', redact: p.redactText };
  if (p.redactText) return { allowed: true, mode: 'redacted', redact: true };
  fail('E_AI_DATA_POLICY', 'sendRealDrawings=false: file not in allowlist and redactText=false');
}

/** Drawing-text redactor: identical strings share one placeholder; restore() maps placeholders back. */
export function createRedactor() {
  const toToken = new Map(), toText = new Map();
  const redact = text => {
    const s = String(text ?? '');
    if (!s) return s;
    if (!toToken.has(s)) { const t = `«T${toToken.size + 1}»`; toToken.set(s, t); toText.set(t, s); }
    return toToken.get(s);
  };
  const restore = text => typeof text === 'string' ? text.replace(/«T\d+»/gu, t => toText.get(t) ?? t) : text;
  return { redact, restore, get size() { return toToken.size; } };
}
/** Restore placeholders inside a Patch v2 (text fields, rationale, question). */
export function restorePatch(patch, redactor) {
  if (!redactor || !patch || typeof patch !== 'object') return patch;
  const out = structuredClone(patch);
  for (const op of Array.isArray(out.ops) ? out.ops : []) {
    if (op?.entity && typeof op.entity.text === 'string') op.entity.text = redactor.restore(op.entity.text);
    if (op?.set && typeof op.set.text === 'string') op.set.text = redactor.restore(op.set.text);
  }
  if (typeof out.rationale === 'string') out.rationale = redactor.restore(out.rationale);
  if (typeof out.needsClarification === 'string') out.needsClarification = redactor.restore(out.needsClarification);
  return out;
}

// ---- transport -------------------------------------------------------------------------------------------------------
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
export const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/**
 * POST JSON with timeout, bounded retries (429/5xx/529, honouring retry-after) and secret-free errors.
 * Error codes: E_AI_TIMEOUT, E_AI_NETWORK, E_AI_HTTP_<status>, E_AI_RESPONSE_LIMIT, E_AI_RESPONSE.
 */
export async function postJson(url, { headers, body, fetcher = fetch, timeoutMs = 120000, retries = 2, sleep = defaultSleep, env = process.env }) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetcher(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (attempt < retries && error?.name !== 'TimeoutError') { await sleep(500 * 2 ** attempt); continue; }
      fail(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'E_AI_TIMEOUT' : 'E_AI_NETWORK');
    }
    const raw = await response.text();
    if (!response.ok) {
      if (RETRY_STATUS.has(response.status) && attempt < retries) {
        const after = Number(response.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      let detail = '';
      try { const e = JSON.parse(raw).error; detail = [e?.type, e?.message].filter(Boolean).join(': '); } catch {}
      fail(`E_AI_HTTP_${response.status}`, scrubSecrets(detail, env).slice(0, 300) || undefined);
    }
    if (raw.length > 8 * 1024 * 1024) fail('E_AI_RESPONSE_LIMIT');
    try { return JSON.parse(raw); } catch { fail('E_AI_RESPONSE', 'invalid JSON body'); }
  }
}

// ---- pricing (APPROXIMATE — edit here) ---------------------------------------------------------------------------------
// USD per 1M tokens, list prices as understood on 2026-10-01. Approximate: verify against the providers' pricing pages
// before quoting money. cacheWrite = 5-minute cache write. For OpenAI, cacheRead = cached input.
export const PRICING_USD_PER_MTOK = Object.freeze({
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'gpt-5.2': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  'gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }
});
export const emptyUsage = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 });
export function addUsage(total, part) {
  for (const k of Object.keys(emptyUsage())) total[k] += Number(part?.[k]) || 0;
  return total;
}
export function estimateCost(model, usage) {
  const key = Object.keys(PRICING_USD_PER_MTOK).filter(k => String(model ?? '').startsWith(k)).sort((a, b) => b.length - a.length)[0];
  if (!key) return { usd: null, approximate: true, model, note: 'no pricing entry' };
  const p = PRICING_USD_PER_MTOK[key];
  const usd = (usage.inputTokens * p.input + usage.outputTokens * p.output + usage.cacheReadTokens * p.cacheRead + usage.cacheWriteTokens * p.cacheWrite) / 1e6;
  return { usd: Math.round(usd * 1e6) / 1e6, approximate: true, model: key };
}
