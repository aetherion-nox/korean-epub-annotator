import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {zipSync,strToU8} from '../epub-fflate.js';

const {JSDOM}=createRequire(import.meta.url)('jsdom');
const html=readFileSync(new URL('../epub.html',import.meta.url),'utf8');
const dom=new JSDOM(html,{url:'https://chrome-extension.test/'});
globalThis.document=dom.window.document;
globalThis.DOMParser=dom.window.DOMParser;
globalThis.XMLSerializer=dom.window.XMLSerializer;
globalThis.NodeFilter=dom.window.NodeFilter;
dom.window.HTMLAnchorElement.prototype.click=function(){};
const el=id=>document.getElementById(id);

const container='<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const opf='<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>';
function fixture(){
 const chapter='<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Test</title></head><body><p>경제 병.</p></body></html>';
 const raw=zipSync({
  mimetype:[strToU8('application/epub+zip'),{level:0}],
  'META-INF/container.xml':[strToU8(container),{level:6}],
  'OEBPS/book.opf':[strToU8(opf),{level:6}],
  'OEBPS/chapter.xhtml':[strToU8(chapter),{level:6}]
 });
 return {name:'one-batch.epub',size:raw.byteLength,
  arrayBuffer:async()=>raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength)};
}
let port;
class Port{
 constructor(){
  this.closed=false;this.sent=[];this.operationId=null;this.id=null;this.messages=[];
  this.onMessage={addListener:f=>this.messages.push(f)};
  this.onDisconnect={addListener:()=>{}};
  this.initialRequests=0;this.responseCount=0;
 }
 emit(msg){queueMicrotask(()=>{
  if(!this.closed)for(const fn of this.messages)fn({operationId:this.operationId,...msg});
 });}
 postMessage(msg){
  if(this.closed)throw Error('Port disconnected');
  this.sent.push(msg);
  if(msg.type==='START'){
   this.operationId=msg.operationId;
   assert.equal(msg.deferReview,true);
   this.emit({type:'REVIEW_PLAN',plannedBatches:1,plannedTargets:2,requestKind:'manual'});
  }
  if(msg.type==='RUN_REVIEW'){
   this.emit({type:'MODEL_BATCH_START',batchNumber:1,batchTotal:1,targets:2});
   this.initialRequests++;
   this.id='example-batch';
   this.emit({type:'MANUAL_REVIEW_REQUEST',requestId:this.id,
    batchNumber:1,batchTotal:1,targetCount:2,
    text:'First model request\n{"format":"shared-pools-v5","batch_id":"example-batch","sentences":[],"candidates":[],"targets":[]}'});
  }
  if(msg.type==='MANUAL_REVIEW_RESPONSE'){
   this.responseCount++;
   assert.equal(msg.requestId,this.id,'targeted retry must stay in same backend batch');
   if(this.responseCount===1){
    this.emit({type:'MANUAL_REVIEW_ERROR',requestId:this.id,
     errorKind:'targeted_correction',batchNumber:1,batchTotal:1,
     acceptedCount:1,totalTargetCount:2,remainingCount:1,
     invalidTargetIds:['t1'],acceptedRows:[{t:'t0',c:'c0'}],
     error:'本批已保存 1/2，t1：无效 c n0',
     repairPrompt:'CORRECTION: only t1\n{"format":"shared-pools-v5","batch_id":"example-batch","sentences":[],"candidates":[],"targets":[{"target_id":"t1"}]}'});
   }else{
    this.emit({type:'MANUAL_REVIEW_ACCEPTED',requestId:this.id,
     batchNumber:1,batchTotal:1,targetCount:2});
    this.emit({type:'MODEL_BATCH_DONE',batchNumber:1,batchTotal:1});
    this.emit({type:'DONE',reviewIncomplete:false,unansweredTargets:0});
   }
  }
  if(msg.type==='KEEPALIVE')this.emit({type:'PONG'});
 }
 disconnect(){this.closed=true;}
}
globalThis.chrome={
 runtime:{
  lastError:null,
  connect:()=>{port=new Port();return port;}
 },
 storage:{
  local:{get:async()=>({manualModelReview:true,hanjaMode:true,loanwordMode:true}),set:async()=>{}},
  onChanged:{addListener(){}}
 }
};
const {handleFile}=await import('../epub-app.js');
const until=async condition=>{
 for(let i=0;i<300;i++){
  if(condition())return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw Error('Timed out waiting for manual review state');
};

test('one planned manual batch with a missing answer explicitly becomes a targeted correction, not a second batch',async()=>{
 const running=handleFile(fixture());
 await until(()=>port?.initialRequests===1&&el('manualPrompt').value.includes('First model request'));
 assert.match(el('manualReviewMeta').textContent,/1\/1 批/);
 assert.equal(el('manualReviewNotice').hidden,true);
 const bad=JSON.stringify({batch_id:'example-batch',results:[{t:'t0',c:'c0'},{t:'t1',c:'n0'}]});
 el('manualAnswer').value=bad;
 el('submitAnswer').click();
 await until(()=>el('manualReviewNotice').textContent.includes('需要补交'));
 assert.equal(port.initialRequests,1,'the correction does not start another LLM batch');
 assert.equal(port.responseCount,1);
 assert.match(el('manualReviewMeta').textContent,/补交第 1 次/);
 assert.match(el('manualReviewMeta').textContent,/已保存 1\/2 条/);
 assert.match(el('manualReviewMeta').textContent,/剩余 1 条/);
 assert.match(el('manualReviewNotice').textContent,/不是新的首轮批次/);
 assert.match(el('manualPrompt').value,/CORRECTION: only t1/);
 assert.match(el('requestPlan').textContent,/第 1 次补交/);
 // A second click with identical invalid content must not bombard the worker.
 el('submitAnswer').click();
 assert.equal(port.responseCount,1);
 assert.match(el('manualStatus').textContent,/未发送/);
 // Submit only the corrected remainder; previously saved t0 stays on worker.
 el('manualAnswer').value=JSON.stringify({batch_id:'example-batch',results:[{t:'t1',c:'c0'}]});
 el('submitAnswer').click();
 await running;
 assert.equal(port.initialRequests,1);
 assert.equal(port.responseCount,2);
 assert.match(el('manualReviewNotice').textContent,/通过校验/);
 assert.match(el('requestPlan').textContent,/首轮审核计划 1 批/);
 assert.equal(el('downloadEpub').disabled,false);
});

test('EPUB v1.2.8 integration keeps null-only IDs and strict worker identity',()=>{
 const local=readFileSync(new URL('../local-engine.js',import.meta.url),'utf8');
 const pipeline=readFileSync(new URL('../annotation-pipeline.js',import.meta.url),'utf8');
 const worker=readFileSync(new URL('../service-worker.js',import.meta.url),'utf8');
 const core=readFileSync(new URL('../repair-validation-core.js',import.meta.url),'utf8');
 assert.match(local,/choice_id!==null/);
 assert.doesNotMatch(local,/choice_id==='KEEP'/);
 assert.match(pipeline,/choice_id:null,type:'keep'/);
 assert.match(worker,/1\.2\.8-epub-pos-independent-pools/);
 assert.match(core,/choice_id=null/);
});

test('manual-review EPUB also retains and exposes the same diagnostic panel',()=>{
 assert.equal(el('epubDiagnostics').hidden,true);
 assert.ok(Number(el('diagnosticCount').textContent)>0);
 el('toggleDiagnostics').click();
 assert.equal(el('epubDiagnostics').hidden,false);
 assert.match(el('diagnosticEntries').textContent,/首轮|完成|辞典|审核/u);
});
