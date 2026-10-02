// Strings for the wave-2 interaction components (merged into i18n.mjs STRINGS).
export const STRINGS2 = {
  ja: {
    step: { load: '図面を読み込み', search: '対象を検索', propose: '変更案を作成', l1: '検証 L1 — 形式・レイヤ', l2: '検証 L2 — 書き込み・再読込', retry: '再試行', done: '完了', failed: '中止', ask: '確認が必要です' },
    stepLoadInfo: '{e} 要素 · {l} レイヤ', stepTools: 'ツール {n} 回', stepOps: '操作 {n} 件', stepAttempt: '試行 {n}', stepRetryBecause: '理由: {code}', progressTitle: 'AIの作業',
    historyOrigin: '開いた時点', historyScrub: '変更履歴', historyCount: '変更 {n}', historyRestore: 'この時点に戻す', restoring: '戻しています…', restored: '{k} 番目の状態に戻しました（保存したファイルは残ります）',
    ctxZoomSel: '選択部分を拡大', ctxFitAll: '全体表示', ctxSelectLayer: '同じレイヤを選択', ctxHideLayer: 'このレイヤを隠す', ctxSolo: 'このレイヤだけ表示', ctxShowAll: 'すべてのレイヤを表示',
    ctxFocus: 'フォーカスモード', ctxFocusOff: 'フォーカスを解除', ctxMove: '移動量を入力…', ctxDelete: '削除…', ctxAsk: 'AIに指示…', ctxCopyId: 'IDをコピー', ctxLabel: '図面メニュー',
    dragFree: '自由', dragGrid: '455 モジュール', dragGridMajor: '910 モジュール', dragEnd: '端点', dragMixedScale: '縮尺の違う要素を含むためドラッグ移動できません',
    sortId: 'ID順', sortCount: '要素数順', sortLabel: 'レイヤの並び', soloOn: '単独表示', soloBtn: 'このレイヤだけ表示',
    focusOn: 'フォーカスモード — 選択以外を暗くしています（Esc / . で解除）', minimap: 'ミニマップ（ドラッグで移動）',
    scrubHint: 'ラベルを左右にドラッグして値を変更（Shift ×10 · Alt 微調整）、Enter で変更案',
    shortcutsList2: [['ドラッグ（選択中の要素）', '移動 — 455 モジュール・端点に吸着、Alt で自由'], ['右クリック / Shift+F10', 'コンテキストメニュー'], ['.', 'フォーカスモード'], ['ラベルをドラッグ', '数値を変更（Shift ×10 · Alt 微調整）']]
  },
  en: {
    step: { load: 'Read the drawing', search: 'Find the targets', propose: 'Draft the change', l1: 'Check L1 — schema & layers', l2: 'Check L2 — write & re-read', retry: 'Retry', done: 'Done', failed: 'Stopped', ask: 'Needs clarification' },
    stepLoadInfo: '{e} entities · {l} layers', stepTools: '{n} tool calls', stepOps: '{n} ops', stepAttempt: 'Attempt {n}', stepRetryBecause: 'because {code}', progressTitle: 'AI progress',
    historyOrigin: 'As opened', historyScrub: 'Edit history', historyCount: '{n} edits', historyRestore: 'Restore this point', restoring: 'Restoring…', restored: 'Restored state {k} (saved files are kept)',
    ctxZoomSel: 'Zoom to selection', ctxFitAll: 'Fit all', ctxSelectLayer: 'Select same layer', ctxHideLayer: 'Hide this layer', ctxSolo: 'Show only this layer', ctxShowAll: 'Show all layers',
    ctxFocus: 'Focus mode', ctxFocusOff: 'Leave focus mode', ctxMove: 'Move by…', ctxDelete: 'Delete…', ctxAsk: 'Ask the AI…', ctxCopyId: 'Copy ID', ctxLabel: 'Drawing menu',
    dragFree: 'free', dragGrid: '455 module', dragGridMajor: '910 module', dragEnd: 'endpoint', dragMixedScale: 'The selection mixes layer scales, so it cannot be dragged',
    sortId: 'By ID', sortCount: 'By count', sortLabel: 'Layer order', soloOn: 'Solo', soloBtn: 'Show only this layer',
    focusOn: 'Focus mode — everything but the selection is dimmed (Esc / . to leave)', minimap: 'Minimap (drag to move)',
    scrubHint: 'Drag a label sideways to change the value (Shift ×10 · Alt fine), Enter to propose',
    shortcutsList2: [['Drag (selected elements)', 'Move — snaps to the 455 module and endpoints, Alt = free'], ['Right-click / Shift+F10', 'Context menu'], ['.', 'Focus mode'], ['Drag a field label', 'Change the number (Shift ×10 · Alt fine)']]
  }
};
