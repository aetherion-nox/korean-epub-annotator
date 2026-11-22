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
const fixture=()=>{
 const body=Array.from({length:181},(_,i)=>'<p>경제를 논의한다. '+i+'</p>').join('');
 const chapter='<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Test</title></head><body>'+body+'</body></html>';
 const files={mimetype:[strToU8('application/epub+zip'),{level:0}],
  'META-INF/container.xml':[strToU8(container),{level:6}],
  'OEBPS/book.opf':[strToU8(opf),{level:6}],
  'OEBPS/chapter.xhtml':[strToU8(chapter),{level:6}]};
 const bytes=zipSync(files);
 return {name:'two-chunk.epub',size:bytes.byteLength,
  arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
};
const ports=[];let nextSequence=0;
class Port{
 constructor(){
  this.id=++nextSequence;this.sent=[];this.closed=false;this.operationId=null;this.sentences=null;
  this.messages=[];this.disconnectCallbacks=[];
  this.onMessage={addListener:f=>this.messages.push(f)};
  this.onDisconnect={addListener:f=>this.disconnectCallbacks.push(f)};
 }
 emit(event){
  queueMicrotask(()=>{
   if(this.closed)return;
   for(const cb of this.messages)cb({operationId:this.operationId,...event});
  });
 }
 postMessage(message){
  if(this.closed)throw Error('The port has disconnected');
  this.sent.push(message);
  if(message.type==='START'){
   assert.equal(message.deferReview,true);
   assert.equal(message.planOnly,false);
   this.operationId=message.operationId;
   this.sentences=message.sentences;
   this.emit({type:'REVIEW_PLAN',plannedBatches:1,plannedTargets:1,requestKind:'api'});
  }
  if(message.type==='RUN_REVIEW'){
   assert.equal(ports.length,2,'all book chunks must be preplanned before first model call');
   assert.ok(ports.every(p=>p.sent.some(x=>x.type==='START')));
   assert.equal(message.operationId,this.operationId);
   const first=this.sentences[0];
   this.emit({type:'MODEL_BATCH_START',batchNumber:1,batchTotal:1,targets:1});
   this.emit({type:'RESULTS',source:'model',replaceModel:true,results:[{
    id:first.id,
    annotations:[{start:0,end:2,surface:'경제',replacement:'經濟',type:'hanja'}],
    reviewed:[{start:0,end:2,surface:'경제'}]
   }]});
   this.emit({type:'MODEL_BATCH_DONE',batchNumber:1,batchTotal:1});
   this.emit({type:'DONE',reviewIncomplete:false,unansweredTargets:0});
  }
  if(message.type==='KEEPALIVE')this.emit({type:'PONG'});
 }
 disconnect(){
  if(this.closed)return;
  this.closed=true;
  for(const cb of this.disconnectCallbacks)cb();
 }
}
globalThis.chrome={
 runtime:{
  lastError:null,
  connect({name}){
   assert.equal(name,'KRA_SENTENCE_STREAM_V1');
   const port=new Port();ports.push(port);return port;
  }
 },
 storage:{
  local:{
   get:async()=>({manualModelReview:false,hanjaMode:true,loanwordMode:true,epubApiConcurrency:2}),
   set:async()=>{}
  },
  onChanged:{addListener(){}}
 }
};
const {handleFile}=await import('../epub-app.js');

test('book-wide two-chunk preflight completes without a duplicated local START and releases only planned LLM requests',async()=>{
 await handleFile(fixture());
 assert.equal(ports.length,2,'large book uses two live worker operations, not four pass invocations');
 assert.equal(ports.filter(p=>p.sent.filter(x=>x.type==='START').length===1).length,2);
 assert.equal(ports.reduce((n,p)=>n+p.sent.filter(x=>x.type==='RUN_REVIEW').length,0),2);
 assert.match(el('requestPlan').textContent,/2 批/);
 assert.equal(el('downloadEpub').disabled,false);
 assert.match(el('status').textContent,/完成 2 处标注/);
 assert.ok(ports.every(p=>p.closed));
 const start=ports.flatMap(p=>p.sent.filter(x=>x.type==='START'));
 assert.equal(start.reduce((n,x)=>n+x.sentences.length,0),181);
 assert.ok(start.every(x=>x.deferReview&&x.reviewAll===false));
});

test('API mode diagnostics are collapsed by default, show batch events, and allow reopening',()=>{
 assert.equal(el('epubDiagnostics').hidden,true);
 assert.ok(Number(el('diagnosticCount').textContent)>0);
 assert.match(el('epubApiConcurrencyHint').textContent,/最大并发 2/);
 el('toggleDiagnostics').click();
 assert.equal(el('epubDiagnostics').hidden,false);
 assert.match(el('diagnosticEntries').textContent,/首轮/);
 el('toggleDiagnostics').click();
 assert.equal(el('epubDiagnostics').hidden,true);
});

test('API finishes every concurrent book group before reporting aggregate missing target count',async()=>{
 ports.length=0;nextSequence=0;
 const basePost=Port.prototype.postMessage;
 Port.prototype.postMessage=function(msg){
  if(msg.type!=='RUN_REVIEW')return basePost.call(this,msg);
  this.sent.push(msg);
  const first=ports.indexOf(this)===0;
  this.emit({type:'MODEL_BATCH_START',batchNumber:1,batchTotal:1,targets:10});
  this.emit({type:'MODEL_BATCH_DONE',batchNumber:1,batchTotal:1});
  if(first)this.emit({type:'DONE',reviewIncomplete:true,unansweredTargets:10});
  else setTimeout(()=>this.emit({type:'DONE',reviewIncomplete:false,unansweredTargets:0}),30);
 };
 try{
  await handleFile(fixture());
  assert.equal(ports.length,2);
  assert.ok(ports.every(p=>p.sent.some(m=>m.type==='RUN_REVIEW')));
  assert.ok(ports.every(p=>p.closed),'all ports must finish before final error');
  assert.match(el('requestPlan').textContent,/已结束 2\/2 批/);
  assert.match(el('status').textContent,/1 组.*10 个目标/);
  assert.equal(el('downloadEpub').disabled,true);
  assert.match(el('diagnosticEntries').textContent,/book-incomplete/);
 }finally{Port.prototype.postMessage=basePost;}
});
