const MAX_BYTES = 2 * 1024 * 1024;
const node = (tag, text) => { const element = document.createElement(tag); if (text) element.textContent = text; return element; };

/** Shared, explicit backup replacement for the two independent local workspaces. */
export function createRestorePanel({ id, store, title, describe, hasUnsaved, onRestore }) {
  const host = node('details');
  host.className = 'restore-panel';
  let locale = 'ja-JP', inputText = '', preview = null, busy = false, error = '', success = false;
  let request = 0, applyButton, summary, warning, input;
  const words = (ja, en) => locale === 'ja-JP' ? ja : en;
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  function button(text, action, disabled = false, name = '') {
    const result = node('button', text); result.type = 'button'; result.className = 'button'; result.disabled = disabled;
    if (name) result.dataset.focusKey = `${id}-${name}`;
    result.addEventListener('click', action); return result;
  }
  function refresh() {
    if (applyButton) applyButton.disabled = !preview || busy || hasUnsaved();
    if (warning) warning.hidden = !hasUnsaved();
    if (summary && !preview) summary.textContent = words('内容が変わりました。もう一度検証してください。', 'Content changed. Validate the preview again.');
  }
  function invalidate() { preview = null; success = false; refresh(); }
  function errorText(code) {
    if (code === 'E_RESTORE_REFRESH') return words('データは保存済みですが画面の更新に失敗しました。再読込して確認してください。', 'Data was saved, but the screen could not refresh. Reload to verify it.');
    if (code.endsWith('_CONFLICT')) return words('保存内容が変わりました。再読込して、復元内容をもう一度確認してください。', 'Saved data changed. Reload and review a new restore preview.');
    if (code.endsWith('_ARCHIVE')) return words('原本の保管領域が満杯か読み取れません。現在の原本と保管済み原本を書き出して保全してください。置換は行っていません。', 'The original archive is full or unreadable. Export the current and archived originals for safekeeping. No replacement was made.');
    if (code.endsWith('_UNSAVED')) return words('未保存の入力を保存または破棄してから復元してください。', 'Save or discard unsaved input before restoring.');
    if (code.endsWith('_EMPTY')) return words('保存データがありません。', 'There is no saved data.');
    return words('読込・検証・保存に失敗しました。復元は完了していません。形式とブラウザーの保存容量を確認してください。', 'Reading, validation or saving failed. Restore did not complete. Check the format and browser storage capacity.');
  }
  function run(action) {
    try { action(); error = ''; } catch (e) { error = e.code || 'E_RESTORE_STORAGE'; }
    draw();
  }
  function download(raw, suffix) {
    if (raw === null || raw === undefined) fail('E_RESTORE_EMPTY');
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }));
    const link = node('a'); link.href = url; link.download = `${id}-${suffix}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function validate() {
    invalidate();
    preview = store.prepareRestore(inputText);
  }
  function draw() {
    const focus = host.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    host.replaceChildren();
    host.append(node('summary', words(title.ja, title.en)));
    const content = node('div'); content.className = 'settings-list';
    content.append(node('p', words('この保存領域をバックアップの内容で置き換えます。正常な現在データは直前バックアップに、読めない原本は別の保管領域に保存してから復元します。別のタブを閉じて操作してください。', 'Replace this workspace with a reviewed backup. The current valid data becomes the previous backup; an unreadable original is archived before recovery. Close other tabs before proceeding.')));
    content.append(button(words('現在の保存データを書き出す', 'Download current saved data'), () => run(() => download(store.exportRaw(), 'current')), !store, 'export'));
    content.append(button(words('保管した原本を書き出す', 'Download archived originals'), () => run(() => download(store.exportQuarantine(), 'originals')), !store, 'archive'));
    content.append(button(words('直前のバックアップを読み込む', 'Load previous backup'), () => run(() => {
      invalidate(); const backup = store.loadBackup(); if (!backup) fail('E_RESTORE_EMPTY');
      inputText = JSON.stringify(backup, null, 2); validate();
    }), !store || busy, 'previous'));
    const label = node('label', words('復元するJSON', 'JSON to restore')); label.className = 'field-label';
    input = node('textarea'); input.rows = 6; input.value = inputText; input.maxLength = MAX_BYTES; input.disabled = busy;
    input.dataset.focusKey = `${id}-json`;
    input.addEventListener('input', () => { inputText = input.value; invalidate(); }); label.append(input); content.append(label);
    const file = node('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
    file.addEventListener('change', async () => {
      const selected = file.files?.[0]; if (!selected) return;
      const ticket = ++request; invalidate(); error = ''; busy = true; draw();
      try {
        if (selected.size > MAX_BYTES) fail('E_RESTORE_LIMIT');
        const raw = await selected.text(); if (ticket !== request) return;
        inputText = raw;
      } catch (e) { if (ticket === request) error = e.code || 'E_RESTORE_STORAGE'; }
      finally { if (ticket === request) { busy = false; draw(); } }
    });
    content.append(file, button(words('ローカルJSONを選択', 'Choose local backup JSON'), () => file.click(), busy, 'file'));
    content.append(button(words('復元内容を検証', 'Validate restore preview'), () => run(validate), !store || busy, 'validate'));
    summary = null;
    if (preview) {
      summary = node('div'); summary.setAttribute('role', 'status');
      summary.append(node('p', preview.mode === 'recover'
        ? words('現在の原本は読めません。原文を保管した後、確認したバックアップで復旧します。直前の正常バックアップは保持します。', 'The current original is unreadable. Archive its exact text, then recover using this backup. The previous good backup is retained.')
        : words('現在: ', 'Current: ') + (preview.current ? describe(preview.current, locale) : words('保存なし', 'Nothing saved'))));
      summary.append(node('p', words('復元後: ', 'After restore: ') + describe(preview.incoming, locale)));
      const details = node('details'); details.append(node('summary', words('置換する全データを確認', 'Inspect all replacement data')));
      const full = node('textarea'); full.readOnly = true; full.rows = 10; full.value = JSON.stringify(preview.incoming, null, 2);
      full.setAttribute('aria-label', words('復元内容の全データ', 'Full restore preview')); details.append(full); summary.append(details); content.append(summary);
    }
    warning = node('p', words('未保存の入力があります。元の画面で保存または破棄してください。', 'There is unsaved input. Save or discard it in its original panel.'));
    warning.className = 'note'; content.append(warning);
    applyButton = button(words('確認したバックアップで置換', 'Replace with reviewed backup'), () => {
      try {
        if (!preview || busy) return;
        if (hasUnsaved()) fail('E_RESTORE_UNSAVED');
        const next = store.applyRestore(preview); preview = null; error = ''; success = true;
        try { onRestore(next); } catch { error = 'E_RESTORE_REFRESH'; success = false; }
      } catch (e) { preview = null; error = e.code || 'E_RESTORE_STORAGE'; success = false; }
      draw();
    }, true, 'apply');
    content.append(applyButton);
    if (error) { const alert = node('p', `${errorText(error)} (${error})`); alert.className = 'error-box'; alert.setAttribute('role', 'alert'); content.append(alert); }
    if (success) { const status = node('p', words('復元しました。図面を再選択して同じ条件で照合してください。', 'Restore completed. Reselect the drawing and verify the same context.')); status.setAttribute('role', 'status'); content.append(status); }
    host.append(content); refresh();
    if (focus) host.querySelector(`[data-focus-key="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
  }
  return { invalidate, refresh, render(nextLocale) { locale = nextLocale; draw(); return host; } };
}
