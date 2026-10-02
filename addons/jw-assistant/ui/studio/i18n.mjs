import { STRINGS2 } from './strings2.mjs';
// Studio strings. Japanese is the default; English is kept as a toggle. Korean instructions are accepted as input.
export const STRINGS = {
  ja: {
    appName: 'Fresco Studio', review: 'レビュー画面', settings: '設定', shortcuts: 'ショートカット', toggleSidebar: 'サイドバー', toggleInspector: 'インスペクタ',
    files: '図面', sourceFiles: '元図面', workFiles: '作業ファイル（保存した変更）', searchFiles: '図面を検索', refresh: '一覧を更新', noFiles: 'JWWが見つかりません',
    noRoot: '図面フォルダが未設定です', noRootBody: '起動時にフォルダを指定してください：\nnode tools/studio-server.mjs 4318 C:/JWW',
    layers: 'レイヤ', showAll: 'すべて表示', layerHidden: '非表示', unnamed: '名称なし', group: 'グループ', entities: '件', soloHint: 'Alt+クリックで単独表示',
    checkBadge: 'チェック', roleFromName: '名前から推定', roleFromProfile: '事務所プロファイル', ruleLayer: '社内ルール',
    emptyTitle: '図面を開いてください', emptyBody: '左の一覧からJWWを選ぶと、印刷と同じ線幅で表示します。原本は変更されず、変更は常に新しいファイルとして保存されます。',
    loading: '読み込み中…', opened: '{name} を開きました', openFailed: '図面を開けませんでした',
    toolSelect: '選択', toolPan: 'パン', fit: '全体表示', fitSelection: '選択部分を拡大', zoomIn: '拡大', zoomOut: '縮小',
    inspectorSelection: '選択', inspectorEmpty: '図面を開いて要素を選ぶと、レイヤ・線色・座標（モデル mm）をここで確認・編集できます。', inspectorCheck: 'レイヤチェック', nothingSelected: '何も選択されていません', nothingSelectedBody: 'クリックで選択、ドラッグで範囲選択（左→右：完全に含む／右→左：交差）。Shiftで追加。',
    document: '図面', entityCount: '要素', layerCount: '使用レイヤ', paper: '用紙範囲', scale: '縮尺', selected: '{n}件を選択', clearSelection: '選択解除',
    kind: { line: '線', arc: '円弧', point: '点', text: '文字', solid: 'ソリッド', block: 'ブロック', dimension: '寸法' },
    layer: 'レイヤ', pen: '線色', lineType: '線種', geometry: '形状（モデル mm）', start: '始点', end: '終点', at: '位置', center: '中心', radius: '半径', length: '長さ',
    text: '文字', height: '文字高さ（用紙 mm）', move: '移動', moveBy: '移動量（モデル mm）', apply: '適用', delete: '削除', blockName: 'ブロック名', readOnly: 'この種類は表示のみです',
    editHint: '値を変えて Enter で変更案を作成します。保存は確認後です。',
    checkSummary: 'エラー {e} · 警告 {w} · 情報 {i}', checkNone: '問題は見つかりませんでした', checkUnavailable: '事務所レイヤプロファイルがありません', showEntities: '該当要素を表示',
    severity: { error: 'エラー', warning: '警告', info: '情報' },
    commandPlaceholder: '指示を入力 — 例：この窓を910右へ ／ 거실 창문 넓혀줘', commandDisabled: '図面を開くとAIに指示できます', send: '送信',
    providerAuto: '自動', providerMock: 'デモ（モック）', providerClaude: 'Claude', providerClaudeFast: 'Claude（高速）', providerOpenAI: 'OpenAI', keyMissing: 'キー未設定',
    keyNotSetTitle: 'APIキーが設定されていません', keyNotSetBody: 'ANTHROPIC_API_KEY または OPENAI_API_KEY を環境変数に設定して、サーバーを再起動してください。いまはモック（デモ）で編集の流れを試せます。図面は外部に送信されません。',
    tryMock: 'デモで試す', dismiss: '閉じる', selectionChip: '{n}件を対象',
    working: 'AIが図面を確認しています…', workingMock: 'デモで変更案を作成しています…', elapsed: '{s} 秒',
    proposal: '変更案', clarification: '確認が必要です', failed: '変更案を作れませんでした', accept: '新しいJWWとして保存', reject: '破棄', retry: '再試行',
    reply: '回答して再実行', replyPlaceholder: '回答を入力', attempts: '試行 {n}/{max}', attemptsShort: '試行 {n}', cost: '≈ ${usd}', costMock: '費用なし（モック）', cost0: '費用 —',
    removed: '削除 {n}', added: '追加 {n}', moved: '移動 {n}', replay: '動きを再生', layerWarnings: 'レイヤの確認', applySuggested: '推奨レイヤを適用（{to}）',
    acceptHint: '⌘↵ で保存 · Esc で破棄', manual: '手動編集', saved: '新しいJWWとして保存しました', savedBody: '{name}', undo: '元に戻す', undone: '1つ前の状態に戻しました（保存したファイルは残ります）',
    rejected: '変更案を破棄しました', nothingToUndo: '元に戻せる変更はありません', copyPath: 'パスをコピー', copied: 'コピーしました',
    errors: {
      E_AI_KEY_REQUIRED: 'APIキーが未設定です（{detail}）。', E_AI_DATA_POLICY: 'データポリシーにより、この図面はクラウドAIに送信できません（設定で変更できます）。',
      E_AI_REFUSAL: 'AIがこの依頼に回答しませんでした。', E_AI_TIMEOUT: 'AIの応答がタイムアウトしました。', E_AI_NETWORK: 'AIに接続できませんでした。',
      E_PATCH_ENTITY: '存在しない要素を参照しました。', E_JWW_REWRITE_UNSAFE: 'この対象は安全に書き換えられません。', E_JWW_EDIT_VERIFY: '書き込み後の検証に失敗しました。',
      E_JWW_CODEC_PARTIAL: 'この図面は一部しか解読できないため編集できません。', E_CODEC_SETLAYER_SCALE: '縮尺の異なるレイヤへブロック・寸法は移せません。',
      E_JWW_EXTERNAL_CHANGE: '図面が変更されています。開き直してください。', E_PREVIEW_STALE: 'この変更案は古くなりました。', E_BUSY: '別の処理中です。少し待ってください。',
      E_SELECTION: '選択が無効です。選び直してください。', E_PATCH_STALE: '図面が更新されています。', E_PATCH_VALUE: '値が範囲外です。', E_PATCH_SCHEMA: '変更内容の形式が不正です。',
      E_PATCH_LAYER: 'そのレイヤはありません。', E_AI_LAYER_FINDINGS: 'レイヤ規則に合わない変更でした。', E_AI_VERIFY_MISMATCH: '適用結果が意図と一致しませんでした。',
      E_JWW_NATIVE_READ: 'JWWを読み込めませんでした。', E_JWW_FORMAT: 'JWW形式ではありません。', E_GENERATOR_MISSING: '平面図ジェネレータがありません。', default: '操作できませんでした。'
    },
    settingsAI: 'AI', defaultProvider: '既定のAI', keys: 'APIキー（環境変数）', keySet: '設定済み', keyUnset: '未設定',
    keyNote: 'キーはこの画面では入力しません。環境変数に設定してサーバーを再起動します。', dataPolicy: 'データポリシー',
    sendReal: '実際の図面をクラウドAIへ送信する', sendRealNote: 'オフにすると、許可リストの図面か文字マスク時のみ送信します。', redact: '図面の文字をマスクして送信', redactNote: '室名などの文字を記号に置き換えて送信し、結果を復元します。座標とレイヤ名は送信されます。',
    display: '表示', language: '言語', theme: 'テーマ', themeSystem: '自動', themeLight: 'ライト', themeDark: 'ダーク', reduceMotion: '動きを減らす', reduceMotionNote: 'OSの設定に加えて、アニメーションをクロスフェードだけにします。',
    credits: '動きと質感の設計は Emil Kowalski 氏の apple-design / emil-design-eng ほかのスキル（MIT）を参考にしています。',
    settingsSaved: '設定を保存しました',
    generator: '平面図を生成', generatorTitle: 'JSON仕様から平面図を生成', generatorBody: '部屋・開口などの仕様（JSON）から新しいJWWを作成し、そのまま開きます。', generate: '生成して開く', generated: '平面図を生成しました', invalidSpec: '仕様に誤りがあります',
    shortcutsList: [['⌘K / Ctrl+K', 'AIへの指示欄'], ['F', '全体表示'], ['Shift+F / ダブルクリック', '選択部分を拡大'], ['+ / −', '拡大・縮小'], ['矢印キー', 'パン'], ['Space+ドラッグ / 中ボタン', 'パン'], ['V / H', '選択ツール / パンツール'], ['Shift+クリック', '選択に追加'], ['Esc', '選択解除・変更案を破棄'], ['⌘↵ / Ctrl+Enter', '変更案を保存'], ['⌘Z / Ctrl+Z', '元に戻す'], ['?', 'このリスト']],
    canvasLabel: 'JWW図面キャンバス。矢印キーでパン、+と−でズーム、Fで全体表示。', selectionAnnounce: '{n}件を選択中', cursor: 'X {x} · Y {y} mm', zoomLabel: '{z}%（原寸=100%）'
  },
  en: {
    appName: 'Fresco Studio', review: 'Review', settings: 'Settings', shortcuts: 'Shortcuts', toggleSidebar: 'Sidebar', toggleInspector: 'Inspector',
    files: 'Drawings', sourceFiles: 'Originals', workFiles: 'Working files (saved edits)', searchFiles: 'Search drawings', refresh: 'Refresh', noFiles: 'No JWW files found',
    noRoot: 'No drawing folder configured', noRootBody: 'Start the server with a folder:\nnode tools/studio-server.mjs 4318 C:/JWW',
    layers: 'Layers', showAll: 'Show all', layerHidden: 'Hidden', unnamed: 'Unnamed', group: 'Group', entities: '', soloHint: 'Alt-click to solo',
    checkBadge: 'Check', roleFromName: 'from name', roleFromProfile: 'office profile', ruleLayer: 'office rule',
    emptyTitle: 'Open a drawing', emptyBody: 'Pick a JWW on the left. It renders with print pen widths. Originals are never modified — every change is saved as a new file.',
    loading: 'Loading…', opened: 'Opened {name}', openFailed: 'Could not open the drawing',
    toolSelect: 'Select', toolPan: 'Pan', fit: 'Fit all', fitSelection: 'Zoom to selection', zoomIn: 'Zoom in', zoomOut: 'Zoom out',
    inspectorSelection: 'Selection', inspectorEmpty: 'Open a drawing and select an element to review and edit its layer, pen and coordinates (model mm) here.', inspectorCheck: 'Layer check', nothingSelected: 'Nothing selected', nothingSelectedBody: 'Click to select, drag for a box (left→right: inside / right→left: crossing). Shift adds.',
    document: 'Drawing', entityCount: 'Entities', layerCount: 'Layers used', paper: 'Paper extent', scale: 'Scale', selected: '{n} selected', clearSelection: 'Clear',
    kind: { line: 'Line', arc: 'Arc', point: 'Point', text: 'Text', solid: 'Solid', block: 'Block', dimension: 'Dimension' },
    layer: 'Layer', pen: 'Pen colour', lineType: 'Line type', geometry: 'Geometry (model mm)', start: 'Start', end: 'End', at: 'Position', center: 'Centre', radius: 'Radius', length: 'Length',
    text: 'Text', height: 'Text height (paper mm)', move: 'Move', moveBy: 'Offset (model mm)', apply: 'Apply', delete: 'Delete', blockName: 'Block', readOnly: 'This kind is view-only',
    editHint: 'Change a value and press Enter to create a proposal. Nothing is saved until you accept.',
    checkSummary: '{e} errors · {w} warnings · {i} info', checkNone: 'No issues found', checkUnavailable: 'No office layer profile', showEntities: 'Show elements',
    severity: { error: 'Error', warning: 'Warning', info: 'Info' },
    commandPlaceholder: 'Describe an edit — e.g. この窓を910右へ / 거실 창문 넓혀줘 / move this 910 right', commandDisabled: 'Open a drawing to ask the AI', send: 'Send',
    providerAuto: 'Auto', providerMock: 'Demo (mock)', providerClaude: 'Claude', providerClaudeFast: 'Claude (fast)', providerOpenAI: 'OpenAI', keyMissing: 'no key',
    keyNotSetTitle: 'API key not set', keyNotSetBody: 'Set ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment and restart the server. Meanwhile, try the whole flow with the mock provider — nothing leaves this machine.',
    tryMock: 'Try the demo', dismiss: 'Dismiss', selectionChip: '{n} targeted',
    working: 'The AI is reading the drawing…', workingMock: 'The demo is drafting a proposal…', elapsed: '{s}s',
    proposal: 'Proposal', clarification: 'Needs clarification', failed: 'No proposal', accept: 'Save as new JWW', reject: 'Discard', retry: 'Retry',
    reply: 'Answer and rerun', replyPlaceholder: 'Your answer', attempts: 'Attempt {n}/{max}', attemptsShort: '{n} attempts', cost: '≈ ${usd}', costMock: 'No cost (mock)', cost0: 'Cost —',
    removed: '{n} removed', added: '{n} added', moved: '{n} moved', replay: 'Replay motion', layerWarnings: 'Layer review', applySuggested: 'Use suggested layer ({to})',
    acceptHint: '⌘↵ save · Esc discard', manual: 'Manual edit', saved: 'Saved as a new JWW', savedBody: '{name}', undo: 'Undo', undone: 'Reverted (the saved file is kept)',
    rejected: 'Proposal discarded', nothingToUndo: 'Nothing to undo', copyPath: 'Copy path', copied: 'Copied',
    errors: {
      E_AI_KEY_REQUIRED: 'API key not set ({detail}).', E_AI_DATA_POLICY: 'The data policy does not allow sending this drawing (see Settings).',
      E_AI_REFUSAL: 'The AI declined this request.', E_AI_TIMEOUT: 'The AI timed out.', E_AI_NETWORK: 'Could not reach the AI.',
      E_PATCH_ENTITY: 'Referenced a missing element.', E_JWW_REWRITE_UNSAFE: 'This target cannot be rewritten safely.', E_JWW_EDIT_VERIFY: 'Verification after writing failed.',
      E_JWW_CODEC_PARTIAL: 'This drawing is only partly decoded and cannot be edited.', E_CODEC_SETLAYER_SCALE: 'Blocks/dimensions cannot move to a layer with another scale.',
      E_JWW_EXTERNAL_CHANGE: 'The drawing changed. Reopen it.', E_PREVIEW_STALE: 'This proposal is out of date.', E_BUSY: 'Busy with another operation.',
      E_SELECTION: 'Invalid selection.', E_PATCH_STALE: 'The drawing was updated.', E_PATCH_VALUE: 'A value is out of range.', E_PATCH_SCHEMA: 'Malformed change.',
      E_PATCH_LAYER: 'No such layer.', E_AI_LAYER_FINDINGS: 'The change broke layer rules.', E_AI_VERIFY_MISMATCH: 'The result did not match the intent.',
      E_JWW_NATIVE_READ: 'Could not read the JWW.', E_JWW_FORMAT: 'Not a JWW file.', E_GENERATOR_MISSING: 'Plan generator not available.', default: 'Something went wrong.'
    },
    settingsAI: 'AI', defaultProvider: 'Default AI', keys: 'API keys (environment)', keySet: 'set', keyUnset: 'not set',
    keyNote: 'Keys are never typed here: set the environment variables and restart the server.', dataPolicy: 'Data policy',
    sendReal: 'Send real drawings to cloud AI', sendRealNote: 'When off, only allow-listed drawings or redacted text are sent.', redact: 'Redact drawing text', redactNote: 'Replaces drawing strings with placeholders and restores them in the result. Geometry and layer names are still sent.',
    display: 'Display', language: 'Language', theme: 'Theme', themeSystem: 'Auto', themeLight: 'Light', themeDark: 'Dark', reduceMotion: 'Reduce motion', reduceMotionNote: 'On top of the OS setting: animations become cross-fades.',
    credits: 'Motion and material design follow Emil Kowalski’s apple-design / emil-design-eng skills (MIT).',
    settingsSaved: 'Settings saved',
    generator: 'Generate plan', generatorTitle: 'Generate a plan from a JSON spec', generatorBody: 'Creates a new JWW from a room/opening spec and opens it.', generate: 'Generate and open', generated: 'Plan generated', invalidSpec: 'The spec has errors',
    shortcutsList: [['⌘K / Ctrl+K', 'Command bar'], ['F', 'Fit all'], ['Shift+F / double-click', 'Zoom to selection'], ['+ / −', 'Zoom'], ['Arrow keys', 'Pan'], ['Space+drag / middle button', 'Pan'], ['V / H', 'Select / pan tool'], ['Shift+click', 'Add to selection'], ['Esc', 'Clear / discard'], ['⌘↵ / Ctrl+Enter', 'Save proposal'], ['⌘Z / Ctrl+Z', 'Undo'], ['?', 'This list']],
    canvasLabel: 'JWW drawing canvas. Arrow keys pan, + and − zoom, F fits.', selectionAnnounce: '{n} selected', cursor: 'X {x} · Y {y} mm', zoomLabel: '{z}% (1:1 = 100%)'
  }
};
for (const k of ['ja', 'en']) Object.assign(STRINGS[k], STRINGS2[k]);

let lang = 'ja';
export function setLang(value) { lang = value === 'en' ? 'en' : 'ja'; return lang; }
export function getLang() { return lang; }
/** t('a.b', {n: 1}) with {name} interpolation; falls back to Japanese, then the key. */
export function t(key, vars = {}) {
  const pick = dict => key.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), dict);
  let value = pick(STRINGS[lang]) ?? pick(STRINGS.ja) ?? key;
  if (typeof value === 'string') value = value.replace(/\{(\w+)\}/gu, (_, k) => (vars[k] ?? `{${k}}`));
  return value;
}
