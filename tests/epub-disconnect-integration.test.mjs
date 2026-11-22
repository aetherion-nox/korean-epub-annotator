import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {zipSync,unzipSync,strToU8,strFromU8} from '../epub-fflate.js';
import {openEpub,exportEpub} from '../epub-core.js';

const {JSDOM}=createRequire(import.meta.url)('jsdom');
const html=readFileSync(new URL('../epub.html',import.meta.url),'utf8');
const dom=new JSDOM(html,{url:'https://chrome-extension.test/'});
globalThis.document=dom.window.document;
globalThis.DOMParser=dom.window.DOMParser;
globalThis.XMLSerializer=dom.window.XMLSerializer;
globalThis.NodeFilter=dom.window.NodeFilter;
const el=id=>document.getElementById(id);

const container='<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const opf='<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>';
const chapter='<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Sample</title></head><body><p>원잠 소식.</p></body></html>';
function book(){
 const files={mimetype:[strToU8('application/epub+zip'),{level:0}],
  'META-INF/container.xml':[strToU8(container),{level:6}],
  'OEBPS/book.opf':[strToU8(opf),{level:6}],
  'OEBPS/c.xhtml':[strToU8(chapter),{level:6}]};
 return openEpub(zipSync(files),'test.epub');
}
const requested=(batchId,sentenceId)=>({
 requestId:batchId,
 batchNumber:1,
 text:'Annotate this:\n'+JSON.stringify({
  format:'shared-pools-v5',batch_id:batchId,
  sentences:[{sentence_id:sentenceId,text:'원잠 소식.'}],
  candidates:[{candidate_id:'p0',type:'hanja',replacement:'原潛',definitions:['nuclear submarine']}],
  targets:[{target_id:'t0',sentence_id:sentenceId,surface:'원잠',options:['p0']}],
  origin_mode:'open-origin',allowed_origin_types:['hanja']
 })
});
let ports=[];
let nextScenario=null;
class Port{
 constructor(scenario){
  this.scenario=scenario;
  this.listeners=[];this.disconnectListeners=[];
  this.closed=false;this.operationId=null;
  this.onMessage={addListener:f=>this.listeners.push(f)};
  this.onDisconnect={addListener:f=>this.disconnectListeners.push(f)};
  this.sent=[];
 }
 emit(event){
  queueMicrotask(()=>{
   if(!this.closed)for(const fn of this.listeners)fn({operationId:this.operationId,...event});
  });
 }
 postMessage(msg){
  if(this.closed)throw Error('Port disconnected');
  this.sent.push(msg);
  if(msg.type==='START'){
   this.operationId=msg.operationId;
   const prompt=requested(this.scenario.batchId,msg.sentences[0].id);
   this.emit({type:'MANUAL_REVIEW_REQUEST',...prompt});
   if(this.scenario.crashWhileWaiting){
    setTimeout(()=>this.crash(),25);
   }
  }
  if(msg.type==='KEEPALIVE')this.emit({type:'PONG'});
  if(msg.type==='MANUAL_REVIEW_RESPONSE'){
   if(this.scenario.crashOnResponse){this.crash();return;}
   const result={id:this.scenario.sentenceId,
    annotations:[{start:0,end:2,surface:'원잠',replacement:'原潛',type:'hanja'}],
    reviewed:[{start:0,end:2,surface:'원잠'}]};
   this.emit({type:'RESULTS',source:'model',replaceModel:true,results:[result]});
   this.emit({type:'MANUAL_REVIEW_ACCEPTED',requestId:this.scenario.batchId});
   this.emit({type:'DONE',reviewIncomplete:false,unansweredTargets:0});
  }
 }
 crash(){
  if(this.closed)return;this.closed=true;
  for(const fn of this.disconnectListeners)fn();
 }
 disconnect(){this.crash();}
}

globalThis.chrome={
 runtime:{
  lastError:null,
  connect({name}){
   assert.equal(name,'KRA_SENTENCE_STREAM_V1');
   const scenario=nextScenario.shift();
   if(!scenario)throw Error('No mock worker available');
   const port=new Port(scenario);ports.push(port);return port;
  }
 },
 storage:{
  local:{
   get:async()=>({manualModelReview:true,hanjaMode:true,loanwordMode:true}),
   set:async()=>{}
  },
  onChanged:{addListener:()=>{}}
 }
};
const {runChunk}=await import('../epub-app.js');
async function until(predicate,timeout=3000){
 const start=Date.now();
 while(!predicate()){
  if(Date.now()-start>timeout)throw Error('Timed out waiting for review UI');
  await new Promise(resolve=>setTimeout(resolve,10));
 }
}
const answer=id=>JSON.stringify({batch_id:id,results:[{t:'t0',c:'c0'}]});
test('manual response survives worker death, rebinds batch ID, and writes original EPUB',async()=>{
 ports=[];
 const b=book(),sentence=b.sentences[0];
 nextScenario=[
  {batchId:'old-id',sentenceId:sentence.id,crashOnResponse:true},
  {batchId:'new-id',sentenceId:sentence.id}
 ];
 const running=runChunk(b.sentences,sentence.text,b,0,{hanja:true,loanword:true},false);
 await until(()=>el('manualPrompt').value.includes('"batch_id":"old-id"'));
 el('manualAnswer').value=answer('old-id');
 el('submitAnswer').click();
 await running;
 assert.equal(ports.length,2);
 assert.equal(ports[0].sent.filter(m=>m.type==='MANUAL_REVIEW_RESPONSE').length,1);
 const rebounded=ports[1].sent.find(m=>m.type==='MANUAL_REVIEW_RESPONSE');
 assert.ok(rebounded,'worker restart must replay valid answer without manual copying');
 assert.equal(rebounded.requestId,'new-id');
 assert.deepEqual(JSON.parse(rebounded.text),{batch_id:'new-id',results:[{t:'t0',c:'c0'}]});
 const final=exportEpub(b);
 assert.equal(final.conversions,1);
 assert.match(strFromU8(unzipSync(final.bytes)['OEBPS/c.xhtml']),/原潛<rt[^>]*>원잠<\/rt>/);
 assert.equal(el('retryConnection').hidden,true);
});

test('answer pasted after disconnection remains editable and is applied after reconnect',async()=>{
 ports=[];
 const b=book(),sentence=b.sentences[0];
 el('manualAnswer').value='';
 nextScenario=[
  {batchId:'before-restart',sentenceId:sentence.id,crashWhileWaiting:true},
  {batchId:'after-restart',sentenceId:sentence.id}
 ];
 const running=runChunk(b.sentences,sentence.text,b,0,{hanja:true,loanword:true},false);
 await until(()=>ports[0]?.closed===true);
 el('manualAnswer').value=answer('before-restart');
 el('submitAnswer').click();
 await running;
 const submitted=ports[1].sent.find(m=>m.type==='MANUAL_REVIEW_RESPONSE');
 assert.ok(submitted);
 assert.equal(JSON.parse(submitted.text).batch_id,'after-restart');
 assert.equal(exportEpub(b).conversions,1);
});
test('EPUB page has downloadable manual TXT and file import controls plus keepalive',()=>{
 assert.ok(el('downloadPrompt'));
 assert.ok(el('importAnswer'));
 assert.ok(el('manualAnswerFile'));
 assert.equal(el('manualAnswerFile').getAttribute('accept'),'.json,.txt,application/json,text/plain');
 const source=readFileSync(new URL('../epub-app.js',import.meta.url),'utf8');
 assert.match(source,/postMessage\(\{type:'KEEPALIVE'/);
 assert.match(source,/RecoverableEngineDisconnect/);
 assert.match(source,/await new Promise\(resolve=>\{resumeResolver=resolve;\}\)/);
});
