// Append-only JSONL experience log (one line per attempt, per run and per user feedback).
// Stored OUTSIDE the repository (settings.experience.dir) because records can contain real drawing data.
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { scrubObject } from './settings.mjs';

export const EXPERIENCE_SCHEMA = 1;
export const sha256 = s => createHash('sha256').update(String(s)).digest('hex');
export function detectLanguage(text) {
  const s = String(text ?? '');
  if (/[가-힣]/u.test(s)) return 'ko';
  if (/[぀-ヿ一-鿿ｦ-ﾟ]/u.test(s)) return 'ja';
  return 'en';
}
// Deterministic instruction tags (drawing-agnostic) used by summaries and learned-rule triggers.
export const INSTRUCTION_PATTERNS = Object.freeze({
  move: /(移動|移す|ずら|動か|寄せ|[上下左右](に|へ)\s*-?\d|이동|옮|움직|내려|올려|\bmove\b)/iu,
  delete: /(削除|消し|消す|消去|取り除|삭제|지워|지우|없애|\bdelete\b|\bremove\b)/iu,
  'add-line': /(線を(引|描|追加)|線分|ライン.*追加|선을?\s*(그|추가|긋)|\bdraw\b|add (a )?line)/iu,
  'add-text': /((文字|テキスト|室名).*(追加|記入|書|入れ)|(追加|記入).*(文字|テキスト)|(글자|텍스트|문자|실명).*(추가|넣|적)|추가.*(글자|텍스트))/iu,
  'change-text': /((を|に).*(変更|書き換|直)|に変え|바꿔|변경|고쳐|수정|rename|change .* to)/iu,
  layer: /(レイヤ|画層|레이어|layer)/iu,
  widen: /(広げ|拡大|大きく|伸ば|넓|늘려|키워|widen|enlarge)/iu,
  dimension: /(寸法|치수|dimension)/iu,
  window: /(窓|サッシ|창문|창\b|window)/iu,
  door: /(戸|扉|ドア|(?<![가-힣])문(?![자서])|door)/iu,
  wall: /(壁|躯体|벽|wall)/iu,
  grid: /(通り芯|芯|중심선|통심|grid)/iu,
  room: /(室|ルーム|リビング|キッチン|玄関|トイレ|浴室|방|거실|주방|현관|화장실|욕실|room)/iu
});
export function classifyInstruction(text) {
  const s = String(text ?? '');
  return Object.entries(INSTRUCTION_PATTERNS).filter(([, re]) => re.test(s)).map(([tag]) => tag);
}
const monthFile = (dir, ts) => path.join(dir, `experience-${ts.slice(0, 7)}.jsonl`);

/**
 * Create an experience store. Every record is secret-scrubbed; with redact=true instructions are replaced by
 * '[redacted]' (hash, language and pattern tags are kept). `fs` is injectable for tests.
 */
export function createExperienceStore({ dir, env = process.env, redact = false, now = () => new Date(), fs = { appendFile, mkdir, readdir, readFile } } = {}) {
  if (!dir) throw Object.assign(new Error('E_EXPERIENCE_DIR'), { code: 'E_EXPERIENCE_DIR' });
  let ready = null;
  async function append(record) {
    ready ??= fs.mkdir(dir, { recursive: true });
    await ready;
    const ts = record.ts ?? now().toISOString();
    const clean = scrubObject({ schemaVersion: EXPERIENCE_SCHEMA, ts, ...record }, env);
    if (redact && typeof clean.instruction === 'string') clean.instruction = '[redacted]';
    await fs.appendFile(monthFile(dir, ts), JSON.stringify(clean) + '\n', 'utf8');
    return clean;
  }
  async function readAll() {
    let names = [];
    try { names = (await fs.readdir(dir)).filter(n => /^experience-\d{4}-\d{2}\.jsonl$/u.test(n)).sort(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const out = [];
    for (const name of names) {
      for (const line of (await fs.readFile(path.join(dir, name), 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* tolerate a torn last line */ }
      }
    }
    return out;
  }
  /** Later user verdict on a run: accepted / rejected / corrected (optionally with the corrected patch). */
  async function recordFeedback({ runId, verdict, correctedPatch = null, note = null }) {
    if (typeof runId !== 'string' || !runId) throw Object.assign(new Error('E_EXPERIENCE_FEEDBACK'), { code: 'E_EXPERIENCE_FEEDBACK' });
    if (!['accepted', 'rejected', 'corrected'].includes(verdict)) throw Object.assign(new Error('E_EXPERIENCE_FEEDBACK'), { code: 'E_EXPERIENCE_FEEDBACK' });
    return append({ type: 'feedback', runId, verdict, correctedPatch, note: note === null ? null : String(note).slice(0, 2000) });
  }
  return { dir, append, readAll, recordFeedback };
}

/** Build the per-attempt record (shape documented in docs/jw-assistant/ai-edit-loop.md). */
export function attemptRecord({ runId, attempt, instruction, sourceHash, provider, model, contextStats, toolCalls, patch, validation, layerFindings, apply, latencyMs, usage, error, evalTaskId = null }) {
  return {
    type: 'attempt', runId, attempt, evalTaskId,
    instructionHash: sha256(instruction), instruction, language: detectLanguage(instruction), patterns: classifyInstruction(instruction),
    sourceHash, provider, model, contextStats,
    toolCalls: (toolCalls ?? []).map(c => ({ name: c.name, ok: c.ok, count: c.count, chars: c.chars, ms: c.ms })),
    patch: patch ?? null,
    opKinds: Array.isArray(patch?.ops) ? patch.ops.map(o => o?.op === 'add' ? `add:${o.entity?.kind}` : o?.op).filter(Boolean) : [],
    validation: validation ?? null, layerFindings: layerFindings ?? [], apply: apply ?? null,
    error: error ? { code: error.code ?? 'E_UNKNOWN', detail: error.detail ?? null } : null,
    latencyMs, usage, feedback: null
  };
}
export const newRunId = () => randomUUID();
