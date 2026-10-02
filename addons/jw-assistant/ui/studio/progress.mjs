// Live AI progress timeline. The server streams NDJSON events from /api/v2/edit-stream (one JSON object per line):
//   { t:'step', id:'load'|'search'|'propose'|'l1'|'l2', state:'run'|'ok'|'fail'|'ask', attempt?, info? }
//   { t:'tool', attempt, name, detail }      — a read-only tool call the model made
//   { t:'retry', attempt, code, detail, layer } — attempt failed; the loop retries with this exact error
//   { t:'result', result } | { t:'error', code, detail }
// reduceProgress() folds events into an ordered step list (pure, tested); readNdjson() parses a fetch body stream.

export const STEP_ORDER = ['load', 'search', 'propose', 'l1', 'l2'];
export const emptyProgress = () => ({ steps: [], attempt: 0, max: 0, done: false, status: null });
const keyOf = (id, attempt) => (id === 'load' ? 'load' : `${id}#${attempt ?? 1}`);

/** Fold one event into the progress state (returns a new state; steps keep identity-stable `key`s for rendering). */
export function reduceProgress(state, ev) {
  const steps = state.steps.map(s => ({ ...s, tools: s.tools.slice() }));
  const upsert = (id, attempt, patch) => {
    const key = keyOf(id, attempt);
    let s = steps.find(x => x.key === key);
    if (!s) { s = { key, id, attempt: id === 'load' ? 0 : attempt ?? 1, state: 'run', tools: [], info: null, error: null }; steps.push(s); }
    Object.assign(s, patch);
    return s;
  };
  let { attempt, max, done, status } = state;
  if (ev.t === 'step') {
    if (ev.attempt) attempt = Math.max(attempt, ev.attempt);
    if (ev.max) max = ev.max;
    // a new step of an attempt implies the earlier running steps of that attempt finished
    if (ev.state === 'run') for (const s of steps) if (s.state === 'run' && s.attempt === (ev.id === 'load' ? 0 : ev.attempt ?? 1) && STEP_ORDER.indexOf(s.id) < STEP_ORDER.indexOf(ev.id)) s.state = 'ok';
    upsert(ev.id, ev.attempt, { state: ev.state, ...(ev.info ? { info: ev.info } : {}) });
  } else if (ev.t === 'tool') {
    const s = upsert('search', ev.attempt, {});
    if (s.tools.length < 24) s.tools.push({ name: ev.name, detail: ev.detail ?? '' });
    s.count = (s.count ?? 0) + 1;
  } else if (ev.t === 'retry') {
    const layer = ev.layer ?? 'propose';
    for (const s of steps) if (s.attempt === ev.attempt && s.state === 'run') s.state = s.id === layer ? 'fail' : 'ok';
    const failed = steps.find(s => s.attempt === ev.attempt && s.id === layer);
    if (failed) { failed.state = 'fail'; failed.error = { code: ev.code, detail: ev.detail ?? null }; }
    else upsert(layer, ev.attempt, { state: 'fail', error: { code: ev.code, detail: ev.detail ?? null } });
    steps.push({ key: `retry#${ev.attempt}`, id: 'retry', attempt: ev.attempt, state: 'ok', tools: [], info: null, error: { code: ev.code, detail: ev.detail ?? null } });
  } else if (ev.t === 'result' || ev.t === 'error') {
    done = true;
    status = ev.t === 'error' ? 'failed' : ev.result?.status ?? 'failed';
    const ok = status === 'applied';
    for (const s of steps) if (s.state === 'run') s.state = ok ? 'ok' : status === 'clarification' ? 'ask' : 'fail';
    if (!ok && status === 'failed') {
      const code = ev.t === 'error' ? ev.code : ev.result?.error?.code;
      const last = [...steps].reverse().find(s => s.id !== 'retry' && s.state === 'fail');
      if (last && !last.error && code) last.error = { code, detail: (ev.t === 'error' ? ev.detail : ev.result?.error?.detail) ?? null };
    }
    steps.push({ key: 'done', id: 'done', attempt, state: ok ? 'ok' : status === 'clarification' ? 'ask' : 'fail', tools: [], info: null, error: null });
  }
  return { steps, attempt, max, done, status };
}

/** Read an NDJSON fetch body, calling onEvent(obj) per line. Resolves when the stream ends. */
export async function readNdjson(body, onEvent) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line) { let ev; try { ev = JSON.parse(line); } catch { continue; } onEvent(ev); }
    }
    if (done) break;
  }
  const tail = buf.trim();
  if (tail) { try { onEvent(JSON.parse(tail)); } catch {} }
}
