import test from 'node:test';
import assert from 'node:assert/strict';
import {runSentencePipeline} from '../annotation-pipeline.js';
import {buildReviewPayload} from '../review-payload.js';

const sentence='경제 문화';
const identity={engine_version:'v15-fixture',dictionary_fingerprint:'v15-fixture',dictionary_metadata:{}};
const analyze=async()=>({...identity,annotations:[],targets:[
 {target_id:'local0',surface:'경제',start:0,end:2,context:sentence,options:[
  {choice_id:null,type:'keep',replacement:'경제',entry_id:null,definitions:[]},
  {choice_id:'c0',type:'hanja',replacement:'經濟',entry_id:1,definitions:['economy']}]},
 {target_id:'local1',surface:'문화',start:3,end:5,context:sentence,options:[
  {choice_id:null,type:'keep',replacement:'문화',entry_id:null,definitions:[]},
  {choice_id:'c0',type:'hanja',replacement:'文化',entry_id:2,definitions:['culture']}]}],
 stats:{pending:2,local_determined:0}});
const message={operationId:'epub-v15',sentences:[{id:'chapter_s0',text:sentence}],context:sentence,
 modes:{hanja:true,loanword:false},epubBookSession:true,allowUserContinuation:true};
const baseConfig={enableModelReview:true,provider:'custom',model:'fixture',endpoint:'https://example.test/v1',
 reviewPosFilter:false,experimentalHanja:false,experimentalLoanword:false,
 smartSegmentation:false,batchContextTier:'32k',discardInvalidReviewResults:false};
const modelConfig=handler=>async()=>({...baseConfig,request:handler});
const run=(data,events,model,extras={})=>runSentencePipeline(data,e=>events.push(e),{
 enabled:true,analyze,status:async()=>identity,cache:new Map(),persist:async()=>{},
 modelConfig:model,...extras});
const until=async fn=>{
 for(let i=0;i<120;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}
 throw Error('Timed out waiting for EPUB review pause');
};
const response=async(config,wire)=>{
 const packed=buildReviewPayload(config.context||'',wire,config).payload;
 return {results:packed.targets.map(x=>({t:x.target_id,c:x.options[0]||null}))};
};

test('after API exhaustion user can explicitly finalize unresolved targets as null without losing accepted Hanja',async()=>{
 const events=[];let resolvePause,calls=0;
 const gate=new Promise(resolve=>{resolvePause=resolve});
 const task=run(message,events,modelConfig(async(config,wire)=>{
  calls++;
  const packed=buildReviewPayload(config.context||'',wire,config).payload;
  return {results:packed.targets.filter(x=>wire.find(w=>w.target_id===x.target_id)?.surface==='경제')
   .map(x=>({t:x.target_id,c:x.options[0]}))};
 }),{waitForUnfinishedReview:()=>gate,
  continuationModelConfig:async()=>({ ...baseConfig,request:async()=>({results:[]}) })});
 await until(()=>events.some(x=>x.type==='REVIEW_PAUSED'));
 const before=calls;
 assert.equal(events.find(x=>x.type==='REVIEW_PAUSED').unansweredTargets,1);
 resolvePause({mode:'null'});
 const stats=await task;
 assert.equal(calls,before,'explicit null cannot trigger API');
 assert.equal(stats.model_unanswered,0);
 assert.equal(stats.model_keep,1);
 assert.equal(stats.model_conversion_choices,1);
 const eventsOfType=events.filter(x=>x.type==='RESULTS'&&x.source==='model');
 assert.ok(eventsOfType.some(x=>x.results.some(y=>
  y.annotations?.some(a=>a.replacement==='經濟')&&
  y.reviewed?.some(r=>r.surface==='문화'))),
 'final result retains approved conversion and overrides unresolved local annotation');
 assert.ok(events.some(x=>x.type==='DONE'&&!x.reviewIncomplete));
});
test('preflight-parked group can be finalized as null before spending any LLM tokens',async()=>{
 const events=[];let release,requested=0;
 const gate=new Promise(resolve=>{release=resolve});
 const task=run({...message,deferReview:true,operationId:'epub-parked-null'},events,
  modelConfig(async()=>{requested++;return {results:[]};}),{waitForReviewStart:()=>gate});
 await until(()=>events.some(e=>e.type==='REVIEW_PLAN'));
 release({mode:'null'});
 const stats=await task;
 assert.equal(requested,0);
 assert.equal(stats.model_keep,2);
 assert.equal(stats.model_unanswered,0);
 assert.ok(events.some(e=>e.type==='DONE'&&e.userFinalizedNull===true));
});
test('worker restart revalidates prior checkpoints and never resends approved target IDs',async()=>{
 const firstEvents=[];
 let originalCalls=0;
 const original=await run({...message,operationId:'epub-first-pass'},firstEvents,
  modelConfig(async(...args)=>{originalCalls++;return response(...args);}));
 const rows=firstEvents.filter(x=>x.type==='EPUB_REVIEW_CHECKPOINT').flatMap(x=>x.rows||[]);
 assert.equal(original.model_unanswered,0);
 assert.equal(originalCalls,1);
 assert.equal(rows.length,2);
 const againEvents=[];
 let retriedCalls=0;
 const resumed=await run({...message,operationId:'epub-restored-pass',epubAcceptedRecovery:rows},
  againEvents,modelConfig(async(...args)=>{retriedCalls++;return response(...args);}));
 assert.equal(retriedCalls,0);
 assert.equal(resumed.model_unanswered,0);
 assert.ok(againEvents.some(e=>e.type==='DIAGNOSTIC'&&e.diagnostic?.stage==='epub-recovered-decisions'));
 assert.ok(againEvents.some(e=>e.type==='RESULTS'&&e.source==='model'));
});
test('tampered or moved checkpoint is ignored rather than being used as proof',async()=>{
 const events=[];let calls=0;
 const saved=[{sentenceId:'chapter_s0',targetId:'local0',start:1,end:3,surface:'经济',c:'c0'}];
 const stats=await run({...message,operationId:'bad-checkpoint',epubAcceptedRecovery:saved},events,
  modelConfig(async(...args)=>{calls++;return response(...args);}));
 assert.equal(stats.model_unanswered,0);
 assert.equal(calls,1,'invalid checkpoint must not bypass model review');
});
test('user-demanded API continuation can retry a model that was auto-stopped',async()=>{
 const events=[];let resume,calls=0;
 const gate=new Promise(resolve=>{resume=resolve});
 const handler=async(_config,wire)=>{
  calls++;
  return {results:wire.map(t=>({t:t.target_id,c:calls<=3?'不存在的假詞源':'null'}))};
 };
 const task=run({...message,operationId:'retry-forced-api'},events,modelConfig(handler),
  {waitForUnfinishedReview:()=>gate,continuationModelConfig:async()=>({...(await modelConfig(handler)()),manualReview:false})});
 await until(()=>events.some(e=>e.type==='REVIEW_PAUSED'));
 const count=calls;
 resume({mode:'api'});
 const stats=await task;
 assert.ok(calls>count,'user explicitly requests a fresh API attempt');
 assert.equal(stats.model_unanswered,0);
});
