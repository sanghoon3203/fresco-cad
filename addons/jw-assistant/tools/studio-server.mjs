import { createServer } from 'node:http';
import { readFile, writeFile, readdir, realpath, mkdir, copyFile, rename, unlink, open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { previewServer } from './serve.mjs';
import { readJww, hash, fail, patchLine, verifyLineEdit, observeRules } from '../native/jww.mjs';
import { generateRules, classifyLayers, generateArchitecture } from '../ai/providers.mjs';
import { toIR, translate } from '../native/jww-pipeline.mjs';
import { architecturalSkills, prepareArchitectureSkill, validateArchitectureResult } from '../ai/architecture-skills.mjs';

export async function studioServer({ drawingRoot = process.env.FRESCO_DRAWING_ROOT,
  workRoot = path.join(process.env.LOCALAPPDATA ?? process.cwd(), 'FrescoAssistant', 'drawings'),
  jwExe = process.env.FRESCO_JW_EXE ?? 'C:\\jww\\Jw_win.exe',
  aiFetch = fetch } = {}) {
  const token = randomBytes(32).toString('hex'), sessions = new Map(), files = new Map();
  let mutationBusy = false, aiBusy = false;
  const credentials = { openai: process.env.OPENAI_API_KEY ?? '', typesafe: process.env.TYPESAFE_API_KEY ?? '', model: process.env.OPENAI_MODEL ?? '', jevModel: 'jev-1.13.0' };
  const staticHandler = previewServer().listeners('request')[0];
  const root = drawingRoot ? await realpath(drawingRoot) : null;
  await mkdir(workRoot, { recursive: true }); workRoot = await realpath(workRoot);
  async function listFiles() {
    files.clear();
    let scanned = 0;
    async function walk(folder) {
      if (++scanned > 1000 || files.size >= 200) return;
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.jww') {
          const resolved = await realpath(full), relative = path.relative(root, resolved);
          if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
          files.set(hash(Buffer.from(relative)).slice(0, 24), { path: resolved, name: relative });
          if (files.size >= 200) break;
        }
      }
    }
    if (root) await walk(root);
    for (const entry of await readdir(workRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jww')) {
        files.set(hash(Buffer.from(`work:${entry.name}`)).slice(0, 24), { path: path.join(workRoot, entry.name), name: `[作業コピー] ${entry.name}`, working: true });
      }
    }
    return [...files].map(([id, value]) => ({ id, name: value.name }));
  }
  function session(id) { const result = sessions.get(id); if (!result) fail('E_SESSION_MISSING'); return result; }
  function snapshot(value) {
    return { id: value.id, name: path.basename(value.path), workPath: value.path, hash: value.hash,
      ir: value.ir ??= toIR(value.bytes, value.document),
      rules: observeRules(value.document, value.hash), adoptedRules: value.adoptedRules ?? [] };
  }
  async function load(value) {
    const bytes = await readFile(value.path); const document = await readJww(bytes);
    value.bytes = bytes; value.hash = hash(bytes); value.document = document; value.ir = null; value.preview = null; return value;
  }
  async function current(value, baseHash) {
    if (baseHash !== value.hash || hash(await readFile(value.path)) !== value.hash) fail('E_JWW_EXTERNAL_CHANGE');
  }
  async function preview(value, patch) {
    const translated = translate(value.bytes, value.document, patch);
    const document = await readJww(translated.bytes);
    verifyLineEdit(translated.expected, document, null, []);
    await current(value, patch.sourceHash);
    const after = toIR(translated.bytes, document), before = value.ir ??= toIR(value.bytes, value.document);
    const changes = patch.ids.map(id => ({ id, before: before.entities.find(e => e.id === id).points, after: after.entities.find(e => e.id === id).points }));
    const summary = { id: randomUUID(), sourceHash: value.hash, outputHash: hash(translated.bytes), patch, changes,
      nativeReparse: true, jwcadVisualVerified: false };
    value.preview = { summary, bytes: translated.bytes, document, ir: after };
    return summary;
  }
  async function bodyOf(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) fail('E_CONTENT_TYPE');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 100000) fail('E_REQUEST_LIMIT'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('E_REQUEST_JSON'); }
  }
  async function route(req, url, data) {
    if (url.pathname === '/api/bootstrap' && req.method === 'GET') return { token, files: await listFiles(), rootConfigured: !!root,
      openaiConfigured: !!credentials.openai, typesafeConfigured: !!credentials.typesafe, model: credentials.model, jevModel: credentials.jevModel, skills: architecturalSkills };
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const value = session(url.searchParams.get('session')); const digest = hash(await readFile(value.path)); return { changed: digest !== value.hash, hash: digest };
    }
    if (url.pathname === '/api/open') {
      if (sessions.size >= 8) fail('E_SESSION_LIMIT');
      const file = files.get(data.fileId); if (!file) fail('E_FILE_SELECTION');
      const info = await stat(file.path); if (info.size > 32 * 1024 * 1024) fail('E_JWW_SIZE');
      const bytes = await readFile(file.path), document = await readJww(bytes), id = randomUUID();
      const target = file.working ? file.path : path.join(workRoot, `${path.basename(file.path, path.extname(file.path)).slice(0, 80)}-${id.slice(0, 8)}.jww`);
      if (!file.working) await writeFile(target, bytes, { flag: 'wx' });
      let adoptedRules = [];
      try {
        const stored = JSON.parse(await readFile(`${target}.rules.json`, 'utf8'));
        if (stored.schemaVersion === 1 && Array.isArray(stored.rules) && stored.rules.length <= 256
          && stored.rules.every(rule => /^[0-9A-F]:[0-9A-F]$/u.test(rule.layerId) && ['allowedColors', 'allowedStyles', 'textHeights'].every(key => Array.isArray(rule[key]) && rule[key].length <= 256 && rule[key].every(Number.isFinite)))) adoptedRules = stored.rules;
      } catch {}
      const value = { id, path: target, bytes, hash: hash(bytes), document, adoptedRules }; sessions.set(id, value); return snapshot(value);
    }
    if (url.pathname === '/api/close') { sessions.delete(data.sessionId); return { closed: true }; }
    if (url.pathname === '/api/reload') return snapshot(await load(session(data.sessionId)));
    if (url.pathname === '/api/skill-preview') {
      const value = session(data.sessionId); await current(value, data.baseHash); value.preview = null;
      if (typeof data.request !== 'string' || !data.request.trim()) fail('E_SKILL_INPUT');
      const bundle = await prepareArchitectureSkill(value.ir ??= toIR(value.bytes, value.document), {
        skillId: data.skillId, entityIds: data.entityIds, request: data.request, officeProfile: value.adoptedRules ?? []
      });
      const reply = await generateArchitecture(bundle, { key: credentials.openai, model: credentials.model, bytes: value.bytes, document: value.document, fetcher: aiFetch });
      await current(value, data.baseHash);
      validateArchitectureResult(reply.result, bundle, { bytes: value.bytes, document: value.document });
      return { ...reply, preview: reply.result.patch ? await preview(value, reply.result.patch) : null };
    }
    if (url.pathname === '/api/preview-translation') {
      const value = session(data.sessionId); await current(value, data.baseHash); value.preview = null;
      return { preview: await preview(value, { schemaVersion: 1, sourceHash: value.hash, op: 'TranslateEntities', ids: data.entityIds, dx: data.dx, dy: data.dy, units: 'model-mm' }) };
    }
    if (url.pathname === '/api/save-preview') {
      const value = session(data.sessionId); await current(value, data.baseHash);
      const pending = value.preview;
      if (!pending || pending.summary.id !== data.previewId || pending.summary.sourceHash !== value.hash) fail('E_PREVIEW_STALE');
      // Save the exact bytes already reparsed and shown in this preview, under a fresh name.
      const target = path.join(workRoot, `${path.basename(value.path, '.jww').slice(0, 80)}-edited-${randomUUID().slice(0, 8)}.jww`);
      const file = await open(target, 'wx');
      try { await file.writeFile(pending.bytes); await file.sync(); } catch (error) { await file.close(); await unlink(target).catch(() => {}); throw error; }
      await file.close();
      const receipt = pending.summary;
      value.path = target; value.bytes = pending.bytes; value.hash = receipt.outputHash; value.document = pending.document; value.ir = pending.ir; value.preview = null;
      return { ...snapshot(value), receipt, savedPath: target };
    }
    if (url.pathname === '/api/save-line') {
      const value = session(data.sessionId);
      if (data.baseHash !== value.hash || hash(await readFile(value.path)) !== value.hash) fail('E_JWW_EXTERNAL_CHANGE');
      const next = patchLine(value.bytes, value.document, data.entityId, data.points);
      const document = await readJww(next.bytes); verifyLineEdit(value.document, document, data.entityId, data.points);
      const temporary = `${value.path}.${randomUUID()}.tmp`, backup = `${value.path}.${Date.now()}.bak`;
      try {
        const file = await open(temporary, 'wx'); try { await file.writeFile(next.bytes); await file.sync(); } finally { await file.close(); }
        if (hash(await readFile(value.path)) !== value.hash) fail('E_JWW_EXTERNAL_CHANGE');
        await copyFile(value.path, backup, constants.COPYFILE_EXCL);
        if (hash(await readFile(value.path)) !== value.hash) fail('E_JWW_EXTERNAL_CHANGE');
        await rename(temporary, value.path);
      } finally { await unlink(temporary).catch(() => {}); }
      value.bytes = next.bytes; value.hash = hash(next.bytes); value.document = document; value.ir = null; value.preview = null;
      return { ...snapshot(value), backupPath: backup };
    }
    if (url.pathname === '/api/open-jw') {
      const value = session(data.sessionId); await stat(jwExe);
      await new Promise((resolve, reject) => { const child = spawn(jwExe, [value.path], { detached: true, stdio: 'ignore' }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); }); });
      return { opened: true };
    }
    if (url.pathname === '/api/adopt-rules') {
      const value = session(data.sessionId); if (data.baseHash !== value.hash) fail('E_JWW_EXTERNAL_CHANGE');
      const candidates = observeRules(value.document, value.hash).candidates;
      if (!Array.isArray(data.ids) || !data.ids.length || new Set(data.ids).size !== data.ids.length || data.ids.some(id => !candidates.some(rule => rule.id === id))) fail('E_RULE_SELECTION');
      value.adoptedRules = candidates.filter(item => data.ids.includes(item.id)).map(item => ({ ...item, status: 'user-confirmed', referenceHash: value.hash }));
      await writeFile(`${value.path}.rules.json`, JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), rules: value.adoptedRules }, null, 2));
      return { adoptedRules: value.adoptedRules };
    }
    if (url.pathname === '/api/ai-config') {
      for (const field of ['openai', 'typesafe', 'model', 'jevModel']) {
        if (data[field] !== undefined) {
          if (typeof data[field] !== 'string' || data[field].length > (field.includes('odel') ? 100 : 1000) || /[\r\n]/u.test(data[field])) fail('E_AI_CONFIG');
          credentials[field] = data[field].trim();
        }
      }
      return { openaiConfigured: !!credentials.openai, typesafeConfigured: !!credentials.typesafe, model: credentials.model, jevModel: credentials.jevModel };
    }
    if (url.pathname === '/api/ai') {
      if (aiBusy) fail('E_AI_BUSY');
      const value = session(data.sessionId);
      if (data.baseHash !== value.hash || data.confirmSend !== true || !['openai', 'typesafe'].includes(data.provider)) fail('E_AI_CONFIRM');
      // Only the exact previewed context supplied by this client is transmitted.
      aiBusy = true;
      try { return data.provider === 'openai' ? await generateRules(data.context, { key: credentials.openai, model: credentials.model })
        : await classifyLayers(data.context, { key: credentials.typesafe, model: credentials.jevModel }); }
      finally { aiBusy = false; }
    }
    fail('E_NOT_FOUND');
  }
  return createServer(async (req, res) => {
    const address = `127.0.0.1:${req.socket.localPort}`, origin = `http://${address}`;
    const url = new URL(req.url, origin);
    if (!url.pathname.startsWith('/api/')) return staticHandler(req, res);
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); };
    if (req.headers.host !== address || (req.headers.origin && req.headers.origin !== origin)) return send(403, { error: 'E_ORIGIN' });
    if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'E_METHOD' });
    if (req.method === 'POST' && (req.headers.origin !== origin || req.headers['x-fresco-token'] !== token)) return send(403, { error: 'E_TOKEN' });
    if (req.method === 'GET' && url.pathname === '/api/download') {
      try { const value = session(url.searchParams.get('session')); const bytes = await readFile(value.path);
        res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Disposition', `attachment; filename="drawing.jww"; filename*=UTF-8''${encodeURIComponent(path.basename(value.path))}`); res.writeHead(200); res.end(bytes);
      } catch { send(404, { error: 'E_FILE_READ' }); } return;
    }
    if (req.method === 'GET' && !['/api/bootstrap', '/api/status'].includes(url.pathname)) return send(405, { error: 'E_METHOD' });
    const mutates = req.method === 'POST' && url.pathname !== '/api/ai';
    if (mutates && mutationBusy) return send(409, { error: 'E_BUSY' });
    if (mutates) mutationBusy = true;
    try { const data = req.method === 'POST' ? await bodyOf(req) : {}; send(200, await route(req, url, data)); }
    catch (error) { send(error.code === 'E_NOT_FOUND' ? 404 : 400, { error: typeof error.code === 'string' && /^E_[A-Z_0-9]+$/u.test(error.code) ? error.code : 'E_STUDIO_OPERATION' }); }
    finally { if (mutates) mutationBusy = false; }
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.argv[2] ?? 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const server = await studioServer({ drawingRoot: process.argv[3] ?? process.env.FRESCO_DRAWING_ROOT });
  server.on('error', error => { console.error(error.code ?? 'E_SERVER'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`JWW Studio: http://127.0.0.1:${port}/ui/studio.html`));
}
