// Persistent JwwHelper reader: one long-lived PowerShell process (native/Jww-Worker.ps1) that loads the DLL once and
// serves line-delimited JSON. Requests are sent one at a time (a client-side bounded queue), each with its own timeout.
// A timed-out or crashed worker is killed and restarted on the next request; too many restarts in a short window put the
// client into a cool-down during which requests fail fast with E_JWW_WORKER_UNAVAILABLE so callers use the one-shot path.
// An idle worker never keeps Node alive (child + pipes are unref'd) and exits by itself when stdin closes.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = (code, detail, extra = {}) => { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, detail, ...extra }); };
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
export const WORKER_SCRIPT = fileURLToPath(new URL('./Jww-Worker.ps1', import.meta.url));
const INFRA = new Set(['E_JWW_WORKER_TIMEOUT', 'E_JWW_WORKER_CRASH', 'E_JWW_WORKER_START', 'E_JWW_WORKER_UNAVAILABLE', 'E_JWW_WORKER_QUEUE_FULL', 'E_JWW_WORKER_CLOSED', 'E_JWW_WORKER_PROTOCOL']);
/** True for failures of the worker machinery itself (the caller should fall back to the one-shot reader). */
export const isWorkerInfraError = error => INFRA.has(error?.code);

export class JwwWorker {
  /**
   * command/args: the process to spawn (tests pass a fake worker). Timeouts in ms. maxQueue bounds waiting requests.
   * maxRestarts within restartWindowMs, then the client refuses work for cooldownMs.
   */
  constructor({ command = powershell, args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER_SCRIPT],
    startTimeoutMs = 60000, requestTimeoutMs = 120000, maxQueue = 16, maxRestarts = 3, restartWindowMs = 60000, cooldownMs = 60000, env } = {}) {
    Object.assign(this, { command, args, startTimeoutMs, requestTimeoutMs, maxQueue, maxRestarts, restartWindowMs, cooldownMs, env });
    this.child = null; this.ready = null; this.queue = []; this.current = null; this.nextId = 1; this.starts = []; this.coolUntil = 0; this.closed = false;
    this.stats = { starts: 0, requests: 0, timeouts: 0, crashes: 0, failures: 0 };
  }

  request(cmd, payload = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(Object.assign(new Error('E_JWW_WORKER_CLOSED'), { code: 'E_JWW_WORKER_CLOSED' }));
    if (Date.now() < this.coolUntil) return Promise.reject(Object.assign(new Error('E_JWW_WORKER_UNAVAILABLE: cooling down after repeated failures'), { code: 'E_JWW_WORKER_UNAVAILABLE' }));
    if (this.queue.length >= this.maxQueue) return Promise.reject(Object.assign(new Error('E_JWW_WORKER_QUEUE_FULL'), { code: 'E_JWW_WORKER_QUEUE_FULL' }));
    return new Promise((resolve, reject) => { this.queue.push({ cmd, payload, timeoutMs, resolve, reject }); this.#pump(); });
  }

  async #pump() {
    if (this.current || !this.queue.length || this.pumping) return;
    this.pumping = true;
    try {
      try { await this.#ensure(); } catch (error) {
        for (const job of this.queue.splice(0)) job.reject(error);
        return;
      }
      const job = this.queue.shift(); if (!job) return;
      const id = this.nextId++;
      this.current = { ...job, id, timer: setTimeout(() => this.#timeout(id), job.timeoutMs) };
      this.#ref(true); this.stats.requests++;
      this.child.stdin.write(`${JSON.stringify({ ...job.payload, id, cmd: job.cmd })}\n`);
    } finally { this.pumping = false; }
  }

  #ensure() {
    if (this.child && this.ready) return this.ready;
    const now = Date.now();
    this.starts = this.starts.filter(t => now - t < this.restartWindowMs);
    if (this.starts.length > this.maxRestarts) { this.coolUntil = now + this.cooldownMs; this.starts = []; return Promise.reject(Object.assign(new Error('E_JWW_WORKER_UNAVAILABLE: too many restarts'), { code: 'E_JWW_WORKER_UNAVAILABLE' })); }
    this.starts.push(now); this.stats.starts++;
    const child = spawn(this.command, this.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: this.env ?? process.env });
    this.child = child; this.buffer = []; this.stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(Object.assign(new Error('E_JWW_WORKER_START: no ready line'), { code: 'E_JWW_WORKER_START' })); this.#kill(child); }, this.startTimeoutMs);
      this.onReady = info => { clearTimeout(timer); this.info = info; resolve(info); };
      this.onStartFail = error => { clearTimeout(timer); reject(error); };
    });
    this.ready.catch(() => {});
    child.stdout.on('data', chunk => this.#data(child, chunk));
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    child.on('error', error => this.#exit(child, Object.assign(new Error(`E_JWW_WORKER_START: ${error.message}`), { code: 'E_JWW_WORKER_START' })));
    child.on('exit', (code, signal) => this.#exit(child, null, code, signal));
    child.stdin.on('error', () => {});
    return this.ready;
  }

  #data(child, chunk) {
    if (child !== this.child) return;
    let at;
    while ((at = chunk.indexOf('\n')) >= 0) {
      this.buffer.push(chunk.slice(0, at)); chunk = chunk.slice(at + 1);
      const line = this.buffer.join('').replace(/\r$/u, ''); this.buffer = [];
      if (line) this.#line(child, line);
    }
    if (chunk) this.buffer.push(chunk);
  }

  #line(child, line) {
    let message;
    try { message = JSON.parse(line); } catch { return this.#protocol(child, `unparseable line ${line.slice(0, 80)}`); }
    if (message.ready) { this.onReady?.(message); this.onReady = null; this.#ref(false); return; }
    const job = this.current;
    if (!job || message.id !== job.id) return this.#protocol(child, `unexpected response id ${message.id}`);
    clearTimeout(job.timer); this.current = null;
    if (message.ok) job.resolve(message.result);
    else { this.stats.failures++; job.reject(Object.assign(new Error(`${message.error?.code}: ${message.error?.message ?? ''}`), { code: message.error?.code ?? 'E_JWW_NATIVE_READ', detail: message.error?.message, fromWorker: true })); }
    if (!this.queue.length) this.#ref(false);
    this.#pump();
  }

  #protocol(child, detail) { this.#kill(child); this.#exit(child, Object.assign(new Error(`E_JWW_WORKER_PROTOCOL: ${detail}`), { code: 'E_JWW_WORKER_PROTOCOL' })); }

  #timeout(id) {
    if (this.current?.id !== id) return;
    this.stats.timeouts++;
    const job = this.current, child = this.child; this.current = null;
    job.reject(Object.assign(new Error(`E_JWW_WORKER_TIMEOUT: ${job.cmd} after ${job.timeoutMs} ms`), { code: 'E_JWW_WORKER_TIMEOUT' }));
    this.child = null; this.ready = null; this.#kill(child);
    this.#pump();
  }

  #exit(child, error, code, signal) {
    if (child !== this.child) return; // already replaced (timeout) or closed
    this.child = null; this.ready = null;
    const reason = error ?? Object.assign(new Error(`E_JWW_WORKER_CRASH: exit ${code ?? signal}${this.stderr ? ` ${this.stderr.trim().slice(-300)}` : ''}`), { code: 'E_JWW_WORKER_CRASH' });
    if (/E_JWW_WORKER_START/u.test(this.stderr) && reason.code === 'E_JWW_WORKER_CRASH') reason.code = 'E_JWW_WORKER_START';
    this.onStartFail?.(reason); this.onStartFail = null; this.onReady = null;
    if (this.current) { this.stats.crashes++; clearTimeout(this.current.timer); const job = this.current; this.current = null; job.reject(reason); }
    if (!this.closed) this.#pump(); // queued work restarts the worker
  }

  #kill(child) { try { child?.kill(); } catch {} }

  #ref(on) {
    const c = this.child; if (!c) return;
    for (const h of [c, c.stdin, c.stdout, c.stderr]) { try { on ? h?.ref?.() : h?.unref?.(); } catch {} }
  }

  /** Graceful shutdown: ask the worker to exit, kill it if it does not within graceMs. Pending requests are rejected. */
  async close({ graceMs = 2000 } = {}) {
    this.closed = true;
    const err = Object.assign(new Error('E_JWW_WORKER_CLOSED'), { code: 'E_JWW_WORKER_CLOSED' });
    for (const job of this.queue.splice(0)) job.reject(err);
    if (this.current) { clearTimeout(this.current.timer); this.current.reject(err); this.current = null; }
    const child = this.child; this.child = null; this.ready = null;
    if (!child || child.exitCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.#kill(child); resolve(); }, graceMs);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { child.stdin.end(`${JSON.stringify({ id: 0, cmd: 'shutdown' })}\n`); } catch { clearTimeout(timer); this.#kill(child); resolve(); }
    });
  }
}

// ---- shared instance + helpers used by native/jww.mjs and native/jww-edit.mjs --------------------------------------------
let shared = null;
export const workerEnabled = () => process.platform === 'win32' && process.env.FRESCO_JWW_WORKER !== '0';
export function sharedWorker() { if (!shared || shared.closed) shared = new JwwWorker(); return shared; }
export async function closeSharedWorker() { const w = shared; shared = null; if (w) await w.close(); }

/** Run `fn(filePath)` with the bytes in a private temp file (the DLL reads paths, not buffers). */
export async function withTempFile(bytes, fn) {
  const folder = await mkdtemp(path.join(tmpdir(), 'fresco-jwwk-')), file = path.join(folder, 'input.jww');
  try { await writeFile(file, bytes, { flag: 'wx' }); return await fn(file); }
  finally { await unlink(file).catch(() => {}); await rmdir(folder).catch(() => {}); }
}

// ---- canonical digests (must match FrescoJwwWorker.Canon / BlocksDigest in Jww-Worker.ps1) --------------------------------
const f64 = new DataView(new ArrayBuffer(8));
function enc(v) {
  if (v === null || v === undefined) return 'N';
  if (typeof v === 'string') return `S${v}`;
  if (typeof v === 'boolean') return v ? 'T' : 'F';
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'N';
  f64.setFloat64(0, v === 0 ? 0 : v);
  return `D${f64.getBigUint64(0).toString(16).padStart(16, '0')}`;
}
function canon(e) {
  let s = `${e.type}\u001f`;
  for (const name of Object.keys(e.props).sort()) s += `${name}=${enc(e.props[name])}\u001e`;
  if (e.components) s += `{${e.components.map(canon).join('')}}`;
  return `${s}\u001d`;
}
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
/** 16-hex digest of one reader entity {type, props, components?} (ids are positional and not part of it). */
export const entityDigest = e => digest(canon(e));
export function blocksDigest(blocks) {
  return digest((blocks ?? []).map(b => `B${enc(b.number)}\u001e${enc(b.name)}\u001e${enc(b.declaredCount)}\u001e${b.entities.map(canon).join('')}\u001c`).join(''));
}
