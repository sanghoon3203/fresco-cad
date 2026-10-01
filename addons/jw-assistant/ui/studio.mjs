import { StudioCanvas } from './studio-canvas.mjs';
const $ = id => document.getElementById(id);
let token = '', drawing = null, selected = new Set(), pending = null, busy = false, pollBusy = false, externalChanged = false;
const view = new StudioCanvas($('canvas'), select, () => busy);
const status = message => { $('status').textContent = message; };
const messages = {
  E_AI_KEY_REQUIRED: 'APIキーを接続設定に入力してください。', E_AI_MODEL_REQUIRED: 'OpenAIモデルIDを設定してください。',
  E_AI_HTTP_401: 'APIキーを確認してください。', E_AI_HTTP_429: 'APIの利用枠またはレート制限を確認して再試行してください。',
  E_AI_NETWORK: 'AIの応答を取得できませんでした。接続を確認して再試行してください。', E_AI_INCOMPLETE: 'AIの応答が完了しませんでした。対象を減らして再試行してください。',
  E_AI_REFUSAL: 'AIがこの依頼に回答できませんでした。依頼内容を確認してください。', E_SKILL_CONTEXT_LIMIT: '選択範囲が大きいため、対象を分けてください。',
  E_SKILL_PATCH: 'AIの変更案は選択対象・対応範囲に一致しません。保存していません。', E_SKILL_EVIDENCE: 'AIの根拠が選択した図面と一致しません。',
  E_JWW_EXTERNAL_CHANGE: '外部でファイルが変更されました。変更案を破棄して再読込してください。', E_PREVIEW_STALE: 'この変更案は無効です。再プレビューしてください。',
  E_JWW_AMBIGUOUS_RECORD: 'この線は現在の書き込み方式では編集できません。', E_JWW_LINE_ONLY: '現在の編集対象は通常線のみです。',
  E_JWW_NATIVE_READ: 'JWWを読み込めませんでした。', E_PATCH_ENTITY: '現在の移動対象は通常線のみです。',
  E_SELECTION_LIMIT: '選択は100個までです。範囲を狭めてください。'
};
async function api(route, data) {
  const response = await fetch(`/api/${route}`, data === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fresco-Token': token }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(), { code: result.error }); return result;
}
const base = () => ({ sessionId: drawing.id, baseHash: drawing.hash });
function controls() {
  for (const id of ['open','refresh','files','configure','clear-keys']) $(id).disabled = busy;
  for (const id of ['layer','entity','entity-search','jw','reload','adopt','audit','prepare-ai']) $(id).disabled = busy || !drawing;
  for (const id of ['skill','request','dx','dy']) $(id).disabled = busy;
  for (const id of ['add-selection','clear-selection','fit-selection']) $(id).disabled = busy || !drawing;
  $('ask-ai').disabled = busy || !selected.size || !$('request').value.trim() || externalChanged;
  $('manual-preview').disabled = busy || !selected.size || externalChanged;
  $('save-preview').disabled = busy || !pending || externalChanged;
  $('discard-preview').disabled = busy || !pending;
  $('generate').disabled = $('classify').disabled = busy || !drawing || !$('consent').checked || !$('ai-context').value.trim();
}
async function run(action) {
  if (busy) return; busy = true; controls();
  try { await action(); } catch (error) {
    if (['E_JWW_EXTERNAL_CHANGE','E_PREVIEW_STALE'].includes(error.code)) { externalChanged = true; invalidate(); }
    status(`${messages[error.code] ?? '操作できませんでした。'} ${error.code ?? 'E_STUDIO'}`);
  } finally { busy = false; controls(); }
}
function option(select, value, text) { const item = document.createElement('option'); item.value=value; item.textContent=text; select.append(item); }
function invalidate(clearResult = true) {
  pending = null; view.preview = null; $('preview-info').textContent = 'まだ変更案はありません。'; $('changes').tBodies[0].replaceChildren();
  if (clearResult) $('architecture-result').textContent = '';
  view.draw(); controls();
}
function select(ids, toggle = false) {
  const next = toggle ? new Set(selected) : new Set();
  for (const id of ids) { if (toggle && next.has(id)) next.delete(id); else next.add(id); }
  if (next.size > 100) { status(messages.E_SELECTION_LIMIT); return; }
  selected = next; view.selected = selected; invalidate();
  const editable = drawing?.ir.entities.filter(e => selected.has(e.id) && e.editable).length ?? 0;
  $('selection-info').textContent = selected.size ? `${selected.size} 個を選択 / 移動可能 ${editable} 個\n${[...selected].join(', ')}` : '選択なし';
  controls();
}
function listEntities() {
  const needle = $('entity-search').value.toLowerCase(); $('entity').replaceChildren(); option($('entity'),'','対象を選択（先頭300件）');
  const items = drawing?.ir.entities.filter(e => (!view.layer || e.layerId === view.layer) && (!needle || `${e.id} ${e.type} ${e.geometry?.text ?? ''}`.toLowerCase().includes(needle))).slice(0,300) ?? [];
  for (const e of items) option($('entity'),e.id,`${e.id} · ${e.type} · ${e.layerId}${e.editable ? ' · 移動可' : ' · 読取'}${e.geometry?.text ? ` · ${e.geometry.text.slice(0,25)}` : ''}`);
}
function receive(value, fit = true) {
  drawing = value; externalChanged = false; view.setDrawing(value.ir); view.layer = ''; selected = new Set(); view.selected = selected;
  $('drawing-title').textContent=value.name; $('work-path').textContent=`現在のファイル: ${value.workPath}`;
  $('layer').replaceChildren(); option($('layer'),'','すべて（非表示レイヤーを含む）');
  for (const layer of value.rules.observations) option($('layer'),layer.id,`${layer.id} ${layer.name || layer.groupName || ''} · ${layer.count}`);
  const c=value.ir.coverage;
  $('coverage').textContent=`最上位 ${c.topLevel} 個 / ブロック定義 ${c.blockDefinitions} 個・内部 ${c.definitionEntities} 個。線・円弧・文字・点とブロック内部を簡易表示。ソリッドと画像は非表示、文字の幅・書体は近似です。診断 ${value.ir.diagnostics.length} 件。`;
  $('download').hidden=false; $('download').href=`/api/download?session=${encodeURIComponent(value.id)}`;
  $('entity-search').value=''; $('ai-context').value=''; $('consent').checked=false; $('ai-result').textContent=''; $('saved-info').textContent='';
  listEntities(); renderRules(); select([]); if (fit) view.fit(); controls();
}
function showPreview(preview) {
  pending=preview; view.preview=preview; $('changes').tBodies[0].replaceChildren();
  if (!preview) { $('preview-info').textContent='実行する変更はありません。AIの回答・確認事項を参照してください。'; view.draw(); return; }
  $('preview-info').textContent=`${preview.changes.length} 本を X ${preview.patch.dx} / Y ${preview.patch.dy} mm 移動。再読込で変更を検証済み。まだ保存していません。関連する寸法文字は自動更新しません。`;
  for (const change of preview.changes) {
    const row=document.createElement('tr');
    for (const value of [change.id, change.before.map(n=>Number(n.toFixed(3))).join(', '), change.after.map(n=>Number(n.toFixed(3))).join(', ')]) { const cell=document.createElement('td'); cell.textContent=value; row.append(cell); }
    $('changes').tBodies[0].append(row);
  }
  view.fit(true); controls();
}
function renderRules() {
  $('rules').replaceChildren();
  for (const rule of drawing.rules.candidates) {
    const label=document.createElement('label'); label.className='check'; const check=document.createElement('input'); check.type='checkbox'; check.dataset.rule=rule.id; check.checked=drawing.adoptedRules.some(r=>r.id===rule.id);
    const text=document.createElement('span'); text.textContent=`${rule.layerId} · ${rule.evidenceCount}件 / 色 ${rule.allowedColors.join(',')} / 線種 ${rule.allowedStyles.join(',')}`;
    label.append(check,text); $('rules').append(label);
  }
  $('rule-result').textContent=`${drawing.adoptedRules.length} 件の採用ルール。`;
}
function configStatus(data) { $('ai-config-status').textContent=`OpenAI: ${data.openaiConfigured ? 'キー設定済み' : 'キー未設定'} / モデル: ${data.model || '未設定'} / Jev: ${data.typesafeConfigured ? '設定済み' : '未設定'}`; }
async function initialize() {
  const data=await api('bootstrap'); token=data.token; $('files').replaceChildren(); for (const file of data.files) option($('files'),file.id,file.name);
  $('skill').replaceChildren(); for (const skill of data.skills) option($('skill'),skill.id,skill.title); $('skill').value='change-planning';
  $('openai-model').value=data.model; $('jev-model').value=data.jevModel; configStatus(data); $('connection').textContent='ローカル接続';
  if (!data.files.length) status('図面フォルダを指定して起動してください。');
}
$('open').onclick=()=>run(async()=>{ const old=drawing?.id; status('JWWとブロックを読み込み中…'); receive(await api('open',{fileId:$('files').value})); if(old) await api('close',{sessionId:old}); status('図面を開きました。対象を選択してください。'); });
$('refresh').onclick=()=>run(initialize);
$('reload').onclick=()=>run(async()=>{ receive(await api('reload',{sessionId:drawing.id})); status('再読込しました。'); });
$('jw').onclick=()=>run(async()=>{ await api('open-jw',{sessionId:drawing.id}); status('現在のJWWをJw_cadで開きました。未保存の変更案は含みません。'); });
$('fit').onclick=()=>view.fit(); $('fit-selection').onclick=()=>view.fit(true);
$('entity-search').oninput=listEntities;
$('entity').onchange=()=>controls();
$('add-selection').onclick=()=>{ if($('entity').value) select([...selected,$('entity').value]); };
$('clear-selection').onclick=()=>select([]);
$('layer').onchange=()=>{ view.layer=$('layer').value; select([]); listEntities(); view.fit(); };
for(const id of ['request','skill','dx','dy']) $(id).oninput=()=>{ invalidate(); };
$('ask-ai').onclick=()=>run(async()=>{
  invalidate(); status('選択した図形をAIに送信中…');
  const reply=await api('skill-preview',{...base(),skillId:$('skill').value,entityIds:[...selected],request:$('request').value});
  const r=reply.result; $('architecture-result').textContent=[...r.findings.map(f=>`[${f.status}] ${f.label}\n${f.rationale}\n根拠: ${f.evidenceIds.join(', ')}`),...r.unknowns.map(s=>`確認事項: ${s}`)].join('\n\n') || '実行する変更はありません。';
  showPreview(reply.preview); status(reply.preview ? 'AIの変更案を表示しています。確認して新しいJWWに保存できます。' : 'AIの回答を表示しました。ファイル変更はありません。');
});
$('manual-preview').onclick=()=>run(async()=>{
  invalidate(); const dx=$('dx').value.trim() ? Number($('dx').value) : NaN,dy=$('dy').value.trim() ? Number($('dy').value) : NaN;
  if(![dx,dy].every(Number.isFinite)) throw Object.assign(new Error(),{code:'E_PATCH_SCHEMA'});
  status('変更を再読込して検証中…'); showPreview((await api('preview-translation',{...base(),entityIds:[...selected],dx,dy})).preview); status('変更前後を表示しました。まだ保存していません。');
});
$('discard-preview').onclick=()=>{ invalidate(); status('変更案を破棄しました。'); };
$('save-preview').onclick=()=>run(async()=>{
  status('新しいJWWを保存中…'); const result=await api('save-preview',{...base(),previewId:pending.id}); receive(result);
  $('saved-info').textContent=`保存先: ${result.savedPath}`; status(`新しいJWWを保存しました。左のリンクからダウンロード、またはJw_cadで開けます。\n${result.savedPath}`);
});
$('configure').onclick=()=>run(async()=>{ const values={model:$('openai-model').value,jevModel:$('jev-model').value}; if($('openai-key').value) values.openai=$('openai-key').value; if($('jev-key').value) values.typesafe=$('jev-key').value;
  try { configStatus(await api('ai-config',values)); status('接続設定を保存しました。'); } finally { $('openai-key').value=''; $('jev-key').value=''; } });
$('clear-keys').onclick=()=>run(async()=>{ configStatus(await api('ai-config',{openai:'',typesafe:''})); $('openai-key').value=''; $('jev-key').value=''; });
$('adopt').onclick=()=>run(async()=>{ const ids=[...$('rules').querySelectorAll('input:checked')].map(e=>e.dataset.rule); drawing.adoptedRules=(await api('adopt-rules',{...base(),ids})).adoptedRules; invalidate(); renderRules(); });
$('audit').onclick=()=>{
  const issues=[]; for(const e of drawing.ir.entities){ const rule=drawing.adoptedRules.find(r=>r.layerId===e.layerId),p=e.sourceProperties; if(!rule) continue;
    if(!rule.allowedColors.includes(p.m_nPenColor)||!rule.allowedStyles.includes(p.m_nPenStyle)||(e.type==='JwwMoji'&&rule.textHeights.length&&!rule.textHeights.includes(p.m_dSizeY))) issues.push(`${e.id} / ${e.layerId}`); }
  $('rule-result').textContent=drawing.adoptedRules.length ? `${issues.length} 件の差異（先頭100件）\n${issues.slice(0,100).join('\n')}` : '先にルールを採用してください。';
};
$('prepare-ai').onclick=()=>{ const layers=drawing.rules.observations.filter(e=>!view.layer||e.id===view.layer).sort((a,b)=>b.count-a.count).slice(0,16);
  $('ai-context').value=JSON.stringify({layers:layers.map(({id,name,groupName,count,colors,styles,textHeights,examples})=>({id,name,groupName,count,colors,styles,textHeights,examples}))},null,2); $('consent').checked=false; controls(); };
$('ai-context').oninput=()=>{ $('consent').checked=false; controls(); }; $('consent').onchange=controls;
for(const [id,provider] of [['generate','openai'],['classify','typesafe']]) $(id).onclick=()=>run(async()=>{
  const result=await api('ai',{...base(),confirmSend:$('consent').checked,provider,context:JSON.parse($('ai-context').value)}); $('ai-result').textContent=JSON.stringify(result,null,2); $('consent').checked=false;
});
window.addEventListener('beforeunload',event=>{ if(pending){event.preventDefault();event.returnValue='';} });
setInterval(async()=>{
  if(!drawing||!$('watch').checked||busy||pollBusy||document.hidden||externalChanged) return; pollBusy=true;
  try { const id=drawing.id,result=await api(`status?session=${encodeURIComponent(id)}`); if(drawing?.id!==id||busy) return;
    if(result.changed){externalChanged=true; invalidate(); status(messages.E_JWW_EXTERNAL_CHANGE);} }
  catch { status('外部変更の監視を確認できません。'); } finally { pollBusy=false; }
},3000);
void run(initialize);
