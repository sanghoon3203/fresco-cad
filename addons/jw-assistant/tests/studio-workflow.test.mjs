import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { studioServer } from '../tools/studio-server.mjs';
import { hash, readJww } from '../native/jww.mjs';
import { toIR } from '../native/jww-pipeline.mjs';
import { generateArchitecture } from '../ai/providers.mjs';
import { prepareArchitectureSkill } from '../ai/architecture-skills.mjs';
import { displayPrimitives, nearestPrimitive } from '../ui/studio-canvas.mjs';

test('canvas resolves reflected block paths to their top-level selection without losing coordinates', () => {
  const items = displayPrimitives({ expandedEntities: [{ path:'e5/b0/e1', geometry:{kind:'line'}, transformToModel:[-1,0,0,1,0,0],modelPoints:[-20,0,-10,0] },
    {path:'e6',geometry:{kind:'line'},transformToModel:[1,0,0,1,0,0],modelPoints:[0,0,100,0]}] });
  assert.equal(nearestPrimitive(items,-15,0,1),'e5');
  assert.equal(nearestPrimitive(items,50,0,1),'e6');
  assert.equal(nearestPrimitive(items,500,0,1),null);
});

test('architecture provider distinguishes refusal/incomplete/error responses without fabricated patches', async () => {
  const bundle={instructions:'test',context:{}};
  const response=value=>async()=>({ok:true,text:async()=>JSON.stringify(value)});
  for(const [value,code] of [[{status:'incomplete'},'E_AI_INCOMPLETE'],[{status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]},'E_AI_REFUSAL'],[{status:'completed',output:[]},'E_AI_RESPONSE']])
    await assert.rejects(generateArchitecture(bundle,{key:'test',model:'test',fetcher:response(value)}),{code});
  await assert.rejects(generateArchitecture(bundle,{key:'',model:'test',fetcher:response({})}),{code:'E_AI_KEY_REQUIRED'});
  await assert.rejects(generateArchitecture(bundle,{key:'test',model:'test',fetcher:async()=>({ok:false,status:401})}),{code:'E_AI_HTTP_401'});
});

test('Studio real JWW: selection -> AI adapter -> preview -> fresh file -> download, stale/tampered proposals rejected',
  { skip:!process.env.FRESCO_JWW_FIXTURE,timeout:120000 },async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'fresco-flow-')),source=path.join(dir,'input'),work=path.join(dir,'work');
  await mkdir(source); const original=await readFile(process.env.FRESCO_JWW_FIXTURE); await writeFile(path.join(source,'sample.jww'),original);
  let mode='valid',calls=0,transmitted;
  const server=await studioServer({drawingRoot:source,workRoot:work,aiFetch:async(url,options)=>{
    calls++; assert.equal(url,'https://api.openai.com/v1/responses'); const payload=JSON.parse(options.body); transmitted=JSON.parse(payload.input);
    assert.equal(payload.store,false); assert.equal(payload.text.format.strict,true);
    assert.ok(!payload.input.includes('"record"')); assert.ok(!payload.input.includes(source)); assert.ok(!payload.input.includes(work));
    const result={schemaVersion:1,sourceHash:transmitted.sourceHash,skillId:transmitted.skillId,findings:[{kind:'translation',status:'observed',label:'Move 910',evidenceIds:[transmitted.selection[0].id],rationale:'Explicit request'}],unknowns:[],
      patch:mode==='no-patch'?null:{schemaVersion:1,sourceHash:transmitted.sourceHash,op:'TranslateEntities',ids:mode==='bad'?['missing']:transmitted.selection.map(e=>e.id),dx:910,dy:0,units:'model-mm'}};
    return {ok:true,text:async()=>JSON.stringify({status:'completed',model:'test-model',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]})};
  }});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); await rm(dir,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`,bootstrap=await(await fetch(`${origin}/api/bootstrap`)).json();
  const post=async(route,data)=>{const r=await fetch(`${origin}/api/${route}`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Fresco-Token':bootstrap.token},body:JSON.stringify(data)});return {status:r.status,...await r.json()};};
  assert.equal((await fetch(`${origin}/ui/studio-canvas.mjs`)).status,200);
  assert.equal((await fetch(`${origin}/api/save-preview`)).status,405);
  const opened=await post('open',{fileId:bootstrap.files[0].id}); assert.equal(opened.status,200); assert.equal(opened.ir.schemaVersion,2);
  const chosen=opened.ir.entities.filter(e=>e.editable).slice(0,2); assert.equal(chosen.length,2);
  const base={sessionId:opened.id,baseHash:opened.hash},ask={...base,skillId:'change-planning',entityIds:chosen.map(e=>e.id),request:'선택한 선을 X+ 910mm 이동해줘'};
  await post('ai-config',{openai:'test-key',model:'test-model'});
  const result=await post('skill-preview',ask); assert.equal(result.status,200); assert.equal(calls,1); assert.equal(transmitted.selection.length,2);
  assert.equal(result.preview.changes.length,2); assert.equal(result.preview.nativeReparse,true);
  for(const change of result.preview.changes) for(let i=0;i<4;i++) assert.ok(Math.abs(change.after[i]-change.before[i]-(i%2?0:910))<1e-7);
  assert.equal((await readdir(work)).filter(f=>f.endsWith('.jww')).length,1,'preview must not save');
  assert.equal((await post('save-preview',{...base,previewId:'invented'})).error,'E_PREVIEW_STALE');
  const saved=await post('save-preview',{...base,previewId:result.preview.id}); assert.equal(saved.status,200); assert.notEqual(saved.savedPath,opened.workPath);
  const bytes=await readFile(saved.savedPath); assert.equal(hash(bytes),result.preview.outputHash);
  const ir=toIR(bytes,await readJww(bytes)); for(const change of result.preview.changes) assert.deepEqual(ir.entities.find(e=>e.id===change.id).points,change.after);
  assert.deepEqual(await readFile(opened.workPath),original); assert.deepEqual(await readFile(path.join(source,'sample.jww')),original);
  assert.deepEqual(Buffer.from(await(await fetch(`${origin}/api/download?session=${saved.id}`)).arrayBuffer()),bytes);
  assert.equal((await post('save-preview',{sessionId:saved.id,baseHash:saved.hash,previewId:result.preview.id})).error,'E_PREVIEW_STALE');
  mode='bad'; assert.equal((await post('skill-preview',{...ask,baseHash:saved.hash})).error,'E_SKILL_PATCH');
  mode='no-patch'; const noPatch=await post('skill-preview',{...ask,baseHash:saved.hash}); assert.equal(noPatch.status,200); assert.equal(noPatch.preview,null);
  const manual=await post('preview-translation',{sessionId:saved.id,baseHash:saved.hash,entityIds:chosen.map(e=>e.id),dx:-910,dy:0}); assert.equal(manual.status,200);
  await writeFile(saved.savedPath,original);
  assert.equal((await post('save-preview',{sessionId:saved.id,baseHash:saved.hash,previewId:manual.preview.id})).error,'E_JWW_EXTERNAL_CHANGE');
  const count=calls; assert.equal((await post('skill-preview',{...ask,baseHash:saved.hash})).error,'E_JWW_EXTERNAL_CHANGE'); assert.equal(calls,count);
});
