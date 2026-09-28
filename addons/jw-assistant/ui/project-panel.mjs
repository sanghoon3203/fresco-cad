import { parseProject, serializeProject, MAX_PROJECT_BYTES } from '../project/file.mjs';

export function createProjectPanel({ hasDrafts, captureCurrent, install, close, readSaved, refresh }) {
  let active = null, baseline = '', pending = null, busy = false, error = '', download = null, discard = false;
  const host = document.createElement('section'); host.className = 'panel project-panel';
  let locale = 'ja-JP';
  const words = (ja, en) => locale === 'ja-JP' ? ja : en;
  const fingerprint = () => JSON.stringify(readSaved());
  const dirty = () => !!active && fingerprint() !== baseline;
  const guarded = () => { if (hasDrafts() || dirty()) throw Object.assign(new Error(), { code: 'E_PROJECT_SAVE_FIRST' }); };
  function node(tag, text) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; }
  function button(text, action, disabled = false) {
    const el = node('button', text); el.type = 'button'; el.className = 'button'; el.disabled = disabled || busy;
    el.addEventListener('click', () => void run(action)); return el;
  }
  async function run(action) {
    if (busy) return;
    busy = true; error = ''; refresh();
    try { await action(); } catch (e) { error = e.code ?? 'E_PROJECT_FILE'; }
    finally { busy = false; refresh(); }
  }
  async function prepare(raw) {
    guarded(); pending = null; const candidate = await parseProject(raw); guarded(); pending = candidate;
  }
  async function activate(candidate, isNew = false) {
    guarded();
    await install(candidate);
    active = candidate.project; baseline = isNew ? '' : fingerprint(); pending = null; download = null; discard = false;
    refresh();
  }
  function draw() {
    host.replaceChildren();
    const body = node('div'); body.className = 'settings-list';
    body.append(node('h2', words('プロジェクトファイル', 'Project file')));
    body.append(node('p', active ? `${active.name} · ${dirty() ? words('ファイル未保存', 'Not saved to file') : words('読込／確認済み', 'Opened / confirmed')}`
      : words('サンプル → 検討・メモを保存 → ファイルを書き出す → 再び開く', 'Sample → save decisions and notes → download file → reopen')));
    body.append(node('p', words('1つの図面・検討記録・現場メモを .jwproject.json に保存します。プロジェクト内の編集はメモリ上です。終了前にダウンロードしてください。',
      'One drawing, decisions and site notes in .jwproject.json. Project edits live in memory; download before leaving.')));
    if (!active) {
      body.append(button(words('サンプルプロジェクトを試す', 'Try sample project'), async () => {
        const response = await fetch('../fixtures/sample.jwproject.json', { cache: 'no-store' });
        if (!response.ok) throw new Error('sample'); await prepare(await response.text());
      }));
      body.append(button(words('現在の図面から作成', 'Create from current drawing'), async () => {
        guarded(); await activate(await parseProject(serializeProject(await captureCurrent())), true);
      }));
    }
    const input = node('input'); input.type = 'file'; input.accept = '.json,.jwproject.json'; input.hidden = true;
    input.addEventListener('change', () => void run(async () => {
      const file = input.files?.[0]; if (!file) return; pending = null; if (file.size > MAX_PROJECT_BYTES) throw Object.assign(new Error(), { code: 'E_PROJECT_LIMIT' });
      await prepare(await file.text());
    }));
    body.append(button(words('プロジェクトを選ぶ', 'Choose project file'), () => input.click()), input);
    if (pending) {
      const p = pending.project;
      body.append(node('p', `${p.name} · ${p.capture.name} · ${p.capture.coordinateMode} · Group ${p.capture.group} · ${p.review.reviews.length} reviews / ${p.field.cards.length} notes`));
      body.append(node('p', words('単位とグループを確認して開いてください。ハッシュ一致は出所の証明ではありません。元のブラウザ記録は変更しません。',
        'Check units and group before opening. A matching hash does not authenticate the source. Existing browser records remain separate.')));
      body.append(button(words('内容を確認して開く', 'Confirm and open'), () => activate(pending)), button(words('取消', 'Cancel'), () => { pending = null; }));
    }
    if (active) {
      body.append(button(words('プロジェクトをダウンロード', 'Download project'), async () => {
        if (hasDrafts()) throw Object.assign(new Error(), { code: 'E_PROJECT_SAVE_FIRST' });
        const saved = readSaved(), token = JSON.stringify(saved);
        const next = { ...active, savedAt: new Date().toISOString(), ...saved };
        const raw = serializeProject(next); await parseProject(raw);
        const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
        const link = node('a'); link.href = url; link.download = `project-${active.id}-${Date.now()}.jwproject.json`;
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
        download = token;
      }));
      if (download !== null) {
        body.append(node('p', words('ダウンロードを要求しました。保存先でファイルを確認後、下のボタンを押してください。',
          'Download requested. Check the file in your download folder, then confirm below.')));
        body.append(button(words('ファイルの保存を確認した', 'I confirmed the downloaded file'), () => {
          if (hasDrafts() || fingerprint() !== download) throw Object.assign(new Error(), { code: 'E_PROJECT_CHANGED' });
          baseline = download; download = null;
        }));
      }
      if (dirty() || hasDrafts()) {
        const label = node('label', words(' 未保存の変更を破棄して閉じる', ' Discard unsaved changes on close'));
        const check = node('input'); check.type = 'checkbox'; check.checked = discard; check.addEventListener('change', () => { discard = check.checked; }); label.prepend(check); body.append(label);
      }
      body.append(button(words('閉じてブラウザ記録に戻る', 'Close and return to browser records'), async () => {
        if (!discard) guarded();
        active = null; baseline = ''; pending = null; download = null; discard = false; await close(); refresh();
      }));
    }
    if (error) body.append(node('p', `${error} · ${words('入力中のメモ・ルールを保存／破棄し、プロジェクトを書き出してください。形式エラーの場合は元のファイルを確認してください。',
      'Save or discard drafts and export the project before switching. For format errors, check the source file.')}`));
    if (busy) body.append(node('p', words('確認中…', 'Checking…')));
    host.append(body);
  }
  return { hasUnsaved: dirty, isActive: () => !!active, isBusy: () => busy, refresh: draw, render(nextLocale) { locale = nextLocale; draw(); return host; } };
}
