import { layerCategories, finishFields, defaultLayerMap, createFieldStore, emptyFieldWorkspace, blankFinishCard, fieldContextKey, saveFinishCard, checkFinishCard, handoffText } from '../field/standards.mjs';

const node = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };
export function createFieldPanel(storage) {
  let store, workspace = emptyFieldWorkspace(), error = '', ready = false;
  try { store = createFieldStore(storage); workspace = store.load(); ready = true; } catch (e) { error = e.code || 'E_FIELD_STORAGE'; }
  let mapDraft = null, card = blankFinishCard(), key = null, requested = null, generation = 0, mapOpen = false, cardOpen = false;
  const host = node('section'); host.className = 'panel field-panel';
  let context = { locale: 'ja-JP', reviewContextKey: null, observedLayers: [] };
  const labelFor = item => context.locale === 'ja-JP' ? item.ja : item.en;
  const words = (ja, en) => context.locale === 'ja-JP' ? ja : en;
  function button(text, action, disabled = false) { const b = node('button', text); b.type = 'button'; b.className = 'button'; b.disabled = disabled; b.addEventListener('click', action); return b; }
  function persist(next) { try { workspace = store.save(next); error = ''; return true; } catch(e) { error = e.code || 'E_FIELD_STORAGE'; return false; } }
  function syncKey() {
    const signature = JSON.stringify([context.reviewContextKey, workspace.layerMap]);
    if (signature === requested) return;
    requested = signature; key = null; card = blankFinishCard(); const ticket = ++generation;
    if (!context.reviewContextKey) return;
    fieldContextKey(context.reviewContextKey, workspace.layerMap).then(value => {
      if (ticket !== generation) return;
      key = value; card = structuredClone(workspace.cards.find(r => r.contextKey === key)?.card ?? blankFinishCard()); draw();
    }).catch(e => { if (ticket === generation) { error = e.code || 'E_FIELD_CONTEXT'; draw(); } });
  }
  function draw() {
    host.replaceChildren();
    const body = node('div'); body.className = 'settings-list';
    body.append(node('h2', words('レイヤー分類と現場確認', 'Layer mapping and site coordination')));
    body.append(node('p', words('既存のCADは変更しません。分類案を実際のグループ:レイヤーに対応させて保存してください。', 'CAD data stays unchanged. Match the proposed categories to actual group:layer numbers before saving.')));
    const savedState = node('p', `${words('保存済みリビジョン','Saved revision')}: ${workspace.revision}`); savedState.setAttribute('role','status'); body.append(savedState);
    if (error) { const alert = node('p', `${words('保存・読込エラー。未保存の内容を確認してください。', 'Storage or validation error. Check unsaved entries.')} ${error}`); alert.className = 'error-box'; alert.setAttribute('role','alert'); body.append(alert); }
    const details = node('details'); details.open = mapOpen; details.addEventListener('toggle', () => { mapOpen = details.open; });
    details.append(node('summary', words('詳細レイヤーテンプレート（34分類）', 'Detailed layer template (34 categories)')));
    details.append(node('p', words('番号は製品の初期提案です。既存図面の意味を自動判定したものではありません。空欄は未対応、複数はカンマ区切り。', 'Numbers are starter proposals, not inferred drawing semantics. Blank means unmapped; separate multiple layers with commas.')));
    details.append(button(words('初期案を入力', 'Fill starter proposal'), () => { mapDraft = Object.fromEntries(defaultLayerMap().map(e => [e.categoryId,e.layers.join(', ')])); draw(); }));
    if (!mapDraft) mapDraft = Object.fromEntries(workspace.layerMap.map(e => [e.categoryId,e.layers.join(', ')]));
    for (const category of layerCategories) {
      const label = node('label', labelFor(category)); label.className = 'field-label';
      const input = node('input'); input.type = 'text'; input.value = mapDraft[category.id] ?? ''; input.placeholder = category.suggestedLayer; input.maxLength = 1280;
      input.addEventListener('input', () => { mapDraft[category.id] = input.value; }); label.append(input); details.append(label);
    }
    details.append(button(words('対応を確認して保存', 'Confirm and save mapping'), () => {
      const layerMap = layerCategories.map(c => ({categoryId:c.id,layers:(mapDraft[c.id] ?? '').split(',').map(v => v.trim().toUpperCase()).filter(Boolean)}));
      if (persist({...workspace,layerMap})) syncKey(); draw();
    }, !ready));
    body.append(details);
    const actual = node('p', words('読み込みレイヤー: ', 'Imported layers: ') + (context.observedLayers.map(layer => {
      const entry = workspace.layerMap.find(e => e.layers.includes(layer)); const category = layerCategories.find(c => c.id === entry?.categoryId);
      return `${layer} → ${category ? labelFor(category) : words('未対応','Unmapped')}`;
    }).join(' / ') || '—')); actual.className = 'note'; body.append(actual);
    const form = node('details'); form.open = cardOpen; form.addEventListener('toggle', () => { cardOpen = form.open; });
    form.append(node('summary', words('現場確認メモ', 'Site coordination note')));
    form.append(node('p', words('検査条件ごとに1枚の確認メモを保存します。未記入項目は引継ぎ不足として表示します。入力済でも施工承認にはなりません。', 'One coordination note per checked context. Missing fields identify handoff gaps. Completed fields still require designer review.')));
    if (!key) form.append(node('p', words('図面を読み込み、単位と対象グループを確認してください。', 'Import a drawing and confirm units and target group first.')));
    const categoryLabel = node('label', words('分類','Category')); categoryLabel.className = 'field-label'; const select = node('select');
    for (const category of layerCategories) { const option = node('option',labelFor(category)); option.value = category.id; select.append(option); }
    select.value = card.categoryId; select.disabled = !key; select.addEventListener('change', () => { card.categoryId = select.value; }); categoryLabel.append(select); form.append(categoryLabel);
    for (const field of finishFields) {
      const label = node('label',labelFor(field)); label.className = 'field-label'; const input = node('textarea'); input.rows = 2; input.maxLength = 600; input.value = card[field.id]; input.disabled = !key;
      input.addEventListener('input', () => { card[field.id] = input.value; }); label.append(input); form.append(label);
    }
    const result = checkFinishCard(card); form.append(node('p', words('保存時の未記入: ','Missing at last check: ') + result.missing.map(id => labelFor(finishFields.find(f => f.id === id))).join(', ')));
    form.append(button(words('確認メモを保存','Save coordination note'), () => { try { persist(saveFinishCard(workspace,key,card)); } catch(e) { error = e.code; } draw(); }, !ready || !key));
    form.append(button(words('引継ぎテキストを表示','Preview handoff text'), () => { output.value = `Context: ${key}\n${handoffText(card, context.locale)}`; output.hidden = false; }, !key));
    const output = node('textarea'); output.readOnly = true; output.rows = 14; output.hidden = true; output.setAttribute('aria-label',words('引継ぎテキスト','Handoff text')); form.append(output); body.append(form);
    body.append(button(words('現在の分類・メモをJSONで表示','View current mapping and notes JSON'), () => { backup.value = JSON.stringify(workspace,null,2); backup.hidden = false; }, !ready));
    const backup = node('textarea'); backup.readOnly = true; backup.hidden = true; backup.rows = 10; backup.setAttribute('aria-label','Field workspace JSON'); body.append(backup); host.append(body);
  }
  return { render(next) { context = next; syncKey(); draw(); return host; } };
}
