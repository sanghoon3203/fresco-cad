import { layerCategories, finishFields, defaultLayerMap, createFieldStore, emptyFieldWorkspace, blankFinishCard, fieldContextKey, saveFinishCard, checkFinishCard, handoffText, parseFieldBackup, restoreFieldBackup } from '../field/standards.mjs';
import { createDrafts } from '../field/drafts.mjs';

const node = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };
export function createFieldPanel(storage) {
  let store, workspace = emptyFieldWorkspace(), error = '', ready = false;
  try { store = createFieldStore(storage); workspace = store.load(); ready = true; } catch (e) { error = e.code || 'E_FIELD_STORAGE'; }
  const drafts = createDrafts(), selectedByContext = new Map();
  let mapDraft = null, mapDirty = false, card = blankFinishCard(), cardId = null, key = null, requested = null, generation = 0;
  let mapOpen = false, cardOpen = false, restoreOpen = false, restoreText = '', restorePreview = null, restoreRevision = null;
  let backupRead = 0, backupBusy = false;
  const host = node('section'); host.className = 'panel field-panel';
  let context = { locale: 'ja-JP', reviewContextKey: null, observedLayers: [] };
  const labelFor = item => context.locale === 'ja-JP' ? item.ja : item.en;
  const words = (ja, en) => context.locale === 'ja-JP' ? ja : en;
  const hasUnsaved = () => mapDirty || drafts.size > 0;
  function button(text, action, disabled = false) { const b = node('button', text); b.type = 'button'; b.className = 'button'; b.disabled = disabled; b.addEventListener('click', action); return b; }
  function invalidatePreview() { restorePreview = null; restoreRevision = null; }
  function persist(next) { try { workspace = store.save(next); error = ''; invalidatePreview(); return true; } catch(e) { error = e.code || 'E_FIELD_STORAGE'; return false; } }
  function entries() {
    if (!key) return [];
    const records = new Map(workspace.cards.filter(r => r.contextKey === key).map(r => [r.id,r]));
    for (const draft of drafts.forContext(key)) records.set(draft.id,draft);
    return [...records.values()];
  }
  function selectCard(id) {
    cardId = id; selectedByContext.set(key,id);
    card = drafts.get(key,id) ?? structuredClone(workspace.cards.find(r => r.contextKey === key && r.id === id)?.card ?? blankFinishCard());
  }
  function dirtyCard() { if (key && cardId) drafts.set(key,cardId,card); invalidatePreview(); updateDraftStatus(); }
  function updateDraftStatus() {
    const status = host.querySelector('[data-draft-status]');
    if (status) status.textContent = !hasUnsaved() ? words('現場メモに未保存の変更はありません。','No unsaved site changes.') : words(`未保存メモ ${drafts.size} 件${mapDirty ? '・レイヤー対応未保存' : ''}。画面内の切替では保持します。閉じる前に保存してください。`, `${drafts.size} unsaved notes${mapDirty ? '; layer mapping unsaved' : ''}. Drafts survive in-app switches. Save before closing.`);
    const summary = host.querySelector('[data-restore-summary]'); if(summary && !restorePreview) summary.textContent = words('内容が変わりました。もう一度検証してください。','Content changed. Validate the preview again.');
    const discard = host.querySelector('[data-discard-note]'); if (discard) discard.disabled = !key || !drafts.get(key,cardId);
    const revert = host.querySelector('[data-revert-map]'); if (revert) revert.disabled = !mapDirty;
    const saveAll = host.querySelector('[data-save-all]'); if (saveAll) saveAll.disabled = !ready || !drafts.size;
    const apply = host.querySelector('[data-restore-apply]'); if (apply) apply.disabled = hasUnsaved() || !restorePreview;
  }
  function syncKey() {
    const signature = JSON.stringify([context.reviewContextKey,workspace.layerMap]);
    if (signature === requested) return;
    requested = signature; key = null; cardId = null; card = blankFinishCard(); const ticket = ++generation;
    if (!context.reviewContextKey) return;
    fieldContextKey(context.reviewContextKey,workspace.layerMap).then(value => {
      if (ticket !== generation) return;
      key = value;
      const records = entries(), prior = selectedByContext.get(key);
      selectCard(records.some(r => r.id === prior) ? prior : records[0]?.id ?? crypto.randomUUID()); draw();
    }).catch(e => { if (ticket === generation) { error = e.code || 'E_FIELD_CONTEXT'; draw(); } });
  }
  function draw() {
    const focus = document.activeElement?.dataset?.fieldFocus;
    host.replaceChildren();
    const body = node('div'); body.className = 'settings-list';
    body.append(node('h2',words('レイヤー分類と現場確認','Layer mapping and site coordination')));
    body.append(node('p',words('既存のCADは変更しません。分類案を実際のグループ:レイヤーに対応させて保存してください。','CAD data stays unchanged. Match the proposed categories to actual group:layer numbers before saving.')));
    const savedState = node('p',`${words('保存済みリビジョン','Saved revision')}: ${workspace.revision}`); savedState.setAttribute('role','status'); body.append(savedState);
    const saveAll = button(words('未保存メモを元の条件でまとめて保存','Save all drafts under original contexts'), () => {
      try { let next = workspace; const pending = drafts.all(); for (const d of pending) next = saveFinishCard(next,d.contextKey,d.card,undefined,d.id);
        if (persist(next)) for (const d of pending) drafts.clear(d.contextKey,d.id);
      } catch(e) { error = e.code; } draw();
    }, !ready || !drafts.size); saveAll.dataset.saveAll = ''; body.append(saveAll);
    const draftStatus = node('p'); draftStatus.dataset.draftStatus = ''; draftStatus.setAttribute('role','status'); body.append(draftStatus);
    if (error) { const alert = node('p',`${words('保存・読込エラー。元の保存データは自動消去しません。','Storage or validation error. Saved data is not automatically cleared.')} ${error}`); alert.className = 'error-box'; alert.setAttribute('role','alert'); body.append(alert); }
    const details = node('details'); details.open = mapOpen; details.addEventListener('toggle',() => {mapOpen=details.open;});
    details.append(node('summary',words('詳細レイヤーテンプレート（34分類）','Detailed layer template (34 categories)')));
    details.append(node('p',words('番号は初期提案です。空欄は未対応、複数はカンマ区切り。変更前の条件に未保存メモがある場合は先に保存してください。','Numbers are starter proposals. Blank means unmapped; separate multiple layers with commas. Save note drafts before changing the mapping.')));
    details.append(button(words('初期案を入力','Fill starter proposal'),() => {mapDraft=Object.fromEntries(defaultLayerMap().map(e=>[e.categoryId,e.layers.join(', ')]));mapDirty=true;invalidatePreview();draw();}));
    if (!mapDraft) mapDraft=Object.fromEntries(workspace.layerMap.map(e=>[e.categoryId,e.layers.join(', ')]));
    const mappingFields=node('div');mappingFields.className='mapping-fields';
    for (const category of layerCategories) {
      const label=node('label',labelFor(category));label.className='field-label';const input=node('input');input.type='text';input.value=mapDraft[category.id]??'';input.placeholder=category.suggestedLayer;input.maxLength=1280;input.dataset.fieldFocus=`map-${category.id}`;
      input.addEventListener('input',()=>{mapDraft[category.id]=input.value;mapDirty=true;invalidatePreview();updateDraftStatus();});label.append(input);mappingFields.append(label);
    }
    details.append(mappingFields);
    details.append(button(words('対応を確認して保存','Confirm and save mapping'),()=>{
      if(drafts.size){error='E_FIELD_UNSAVED';draw();return;}
      const layerMap=layerCategories.map(c=>({categoryId:c.id,layers:(mapDraft[c.id]??'').split(',').map(v=>v.trim().toUpperCase()).filter(Boolean)}));
      if(persist({...workspace,layerMap})){mapDirty=false;syncKey();}draw();
    },!ready));
    const revertMap=button(words('保存済みの対応に戻す','Revert mapping draft'),()=>{mapDraft=null;mapDirty=false;draw();},!mapDirty);revertMap.dataset.revertMap='';details.append(revertMap);
    body.append(details);
    body.append(node('p',words('読み込みレイヤー: ','Imported layers: ')+(context.observedLayers.map(layer=>{const entry=workspace.layerMap.find(e=>e.layers.includes(layer));const category=layerCategories.find(c=>c.id===entry?.categoryId);return `${layer} → ${category?labelFor(category):words('未対応','Unmapped')}`;}).join(' / ')||'—')));
    const form=node('details');form.open=cardOpen;form.addEventListener('toggle',()=>{cardOpen=form.open;});form.append(node('summary',words('現場確認メモ','Site coordination notes')));
    form.append(node('p',words('場所ごとに複数のメモを保存できます。最大100件。未記入項目を表示し、入力済でも設計者の確認が必要です。','Save separate notes for each location, up to 100 in total. Missing fields are shown; completed notes still require designer review.')));
    if(!key) form.append(node('p',words('図面を読み込み、単位と対象グループを確認してください。','Import a drawing and confirm units and target group first.')));
    const records=entries();if(cardId&&!records.some(r=>r.id===cardId)) records.push({id:cardId,card});
    const pickerLabel=node('label',words('場所別メモ','Location note'));pickerLabel.className='field-label';const picker=node('select');picker.disabled=!key;picker.dataset.fieldFocus='note-picker';
    for(const [i,r] of records.entries()){const option=node('option',`${i+1}. ${r.card.location.trim()||words('場所未入力','Location missing')}${drafts.get(key,r.id)?' *':''}`);option.value=r.id;picker.append(option);}picker.value=cardId??'';
    picker.addEventListener('change',()=>{selectCard(picker.value);draw();});pickerLabel.append(picker);form.append(pickerLabel);
    form.append(button(words('別の場所のメモを追加','Add location note'),()=>{selectCard(crypto.randomUUID());dirtyCard();draw();},!key||workspace.cards.length+drafts.size>=100));
    const categoryLabel=node('label',words('分類','Category'));categoryLabel.className='field-label';const select=node('select');select.dataset.fieldFocus='category';
    for(const category of layerCategories){const option=node('option',labelFor(category));option.value=category.id;select.append(option);}select.value=card.categoryId;select.disabled=!key;select.addEventListener('change',()=>{card.categoryId=select.value;dirtyCard();});categoryLabel.append(select);form.append(categoryLabel);
    const finishGrid=node('div');finishGrid.className='finish-fields';
    for(const field of finishFields){const label=node('label',labelFor(field));label.className='field-label';const input=node('textarea');input.rows=2;input.maxLength=600;input.value=card[field.id];input.disabled=!key;input.dataset.fieldFocus=field.id;input.addEventListener('input',()=>{card[field.id]=input.value;dirtyCard();});label.append(input);finishGrid.append(label);}
    form.append(finishGrid);
    const result=checkFinishCard(card);form.append(node('p',words('前回表示時の未記入: ','Missing at last display: ')+result.missing.map(id=>labelFor(finishFields.find(f=>f.id===id))).join(', ')));
    form.append(button(words('確認メモを保存','Save coordination note'),()=>{try{if(persist(saveFinishCard(workspace,key,card,undefined,cardId)))drafts.clear(key,cardId);}catch(e){error=e.code;}draw();},!ready||!key));
    const discardNote=button(words('このメモの未保存変更を破棄','Discard this note draft'),()=>{drafts.clear(key,cardId);selectCard(cardId);draw();},!key||!drafts.get(key,cardId));discardNote.dataset.discardNote='';form.append(discardNote);
    form.append(button(words('引継ぎテキストを表示','Preview handoff text'),()=>{output.value=`Context: ${key}\nNote: ${cardId}\n${handoffText(card,context.locale)}`;output.hidden=false;},!key));
    const output=node('textarea');output.readOnly=true;output.rows=14;output.hidden=true;output.setAttribute('aria-label',words('引継ぎテキスト','Handoff text'));form.append(output);body.append(form);
    body.append(button(words('現在の分類・メモをJSONで表示','View current mapping and notes JSON'),()=>{backup.value=JSON.stringify(workspace,null,2);backup.hidden=false;},!ready));
    body.append(button(words('直前のバックアップをJSONで表示','View previous field backup JSON'),()=>{try{backup.value=JSON.stringify(store.loadBackup(),null,2);backup.hidden=false;}catch(e){error=e.code;draw();}},!store));
    const backup=node('textarea');backup.readOnly=true;backup.hidden=true;backup.rows=10;backup.setAttribute('aria-label','Field workspace JSON');body.append(backup);
    const restore=node('details');restore.open=restoreOpen;restore.addEventListener('toggle',()=>{restoreOpen=restore.open;});restore.append(node('summary',words('分類・現場メモのバックアップ復元','Restore mapping and site notes')));
    restore.append(node('p',words('JSONを検証してから置換内容を確認します。現在の保存済み分類・メモを置き換え、直前の正常データをバックアップします。事務所の検討記録は別データです。','Validate the JSON and review the replacement first. This replaces saved mapping and site notes, preserving the previous good version. Office review decisions are separate.')));
    const input=node('textarea');input.value=restoreText;input.rows=6;input.disabled=backupBusy;input.maxLength=2*1024*1024;input.dataset.fieldFocus='restore-json';input.setAttribute('aria-label',words('復元するJSON','JSON to restore'));input.addEventListener('input',()=>{restoreText=input.value;invalidatePreview();updateDraftStatus();});restore.append(input);
    const file=node('input');file.type='file';file.accept='.json,application/json';file.hidden=true;
    file.addEventListener('change',async()=>{const selected=file.files?.[0];if(!selected)return;const ticket=++backupRead;invalidatePreview();if(selected.size>2*1024*1024){error='E_FIELD_LIMIT';draw();return;}backupBusy=true;draw();try{const text=await selected.text();if(ticket!==backupRead)return;restoreText=text;error='';}catch{if(ticket===backupRead)error='E_FIELD_STORAGE';}finally{if(ticket===backupRead){backupBusy=false;draw();}}});
    restore.append(file,button(words('ローカルJSONを選択','Choose local backup JSON'),()=>file.click(),backupBusy));
    restore.append(button(words('復元内容を検証','Validate restore preview'),()=>{try{restorePreview=parseFieldBackup(restoreText);restoreRevision=workspace.revision;error='';}catch(e){invalidatePreview();error=e.code||'E_FIELD_SCHEMA';}draw();},backupBusy));
    if(restorePreview){const restoreSummary=node('p',words(`置換後: メモ ${restorePreview.cards.length}件、分類 ${restorePreview.layerMap.length}件。現在: メモ ${workspace.cards.length}件。`,`Replacement: ${restorePreview.cards.length} notes, ${restorePreview.layerMap.length} categories. Current: ${workspace.cards.length} notes.`));restoreSummary.dataset.restoreSummary='';restore.append(restoreSummary);restore.append(node('p',words('未保存のメモ・分類を保存または破棄してから復元してください。','Save or discard unsaved notes and mapping before restoring.')));}
    const apply=button(words('確認したバックアップで置換','Replace with reviewed backup'),()=>{if(!restorePreview||hasUnsaved()||restoreRevision!==workspace.revision)return;try{if(persist(restoreFieldBackup(workspace,restorePreview))){mapDraft=null;requested=null;syncKey();}}catch(e){error=e.code;}draw();},!ready||!restorePreview||hasUnsaved());apply.dataset.restoreApply='';restore.append(apply);body.append(restore);host.append(body);updateDraftStatus();
    for(const el of host.querySelectorAll('[data-field-focus]')) el.dataset.focusKey=`field-${el.dataset.fieldFocus}`;
    if(focus)host.querySelector(`[data-field-focus="${CSS.escape(focus)}"]`)?.focus({preventScroll:true});
  }
  return {hasUnsaved, render(next){context=next;syncKey();draw();return host;}};
}
