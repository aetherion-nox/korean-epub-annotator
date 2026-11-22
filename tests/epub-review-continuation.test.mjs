import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runSentencePipeline} from '../annotation-pipeline.js';
import {createManualReviewSession} from '../manual-review.js';
import {reviewTargets} from '../choice-review.js';
import {buildReviewPayload} from '../review-payload.js';

const identity={engine_version:'epub-review-continue',dictionary_fingerprint:'fixture-dict',dictionary_metadata:{}};
const sentence='경제 문화';
const target=(surface,start,replacement,id)=>({
 target_id:id,surface,start,end:start+surface.length,context:sentence,
 options:[
  {choice_id:null,type:'keep',replacement:surface,entry_id:null,definitions:[]},
  {choice_id:'c0',type:'hanja',replacement,entry_id:100+start,
   definitions:['tested Hanja noun'],written_form:surface,part_of_speech:'명사'}
 ]
});
const originals=[target('경제',0,'經濟','orig0'),target('문화',3,'文化','orig1')];
const analyze=async()=>({...identity,annotations:[],targets:originals,
 stats:{pending:2,local_determined:0}});
const base={
 operationId:'epub-continue-test',epubBookSession:true,allowUserContinuation:true,
 sentences:[{id:'ep0_s0',text:sentence}],context:sentence,
 modes:{hanja:true,loanword:false},reviewLocalConversions:true
};
const options={reviewPosFilter:false,retryInvalidDictionaryChoices:true,
 discardInvalidReviewResults:false,experimentalHanja:false,
 experimentalLoanword:false,smartSegmentation:false,batchContextTier:'32k'};
const manual=answerAll=>({
 ...options,manualReview:true,provider:'manual',model:'manual',endpoint:'manual://chat',
 request:async(_config,wire)=>({results:wire.filter(t=>answerAll||t.surface==='경제')
  .map(t=>({t:t.target_id,c:'c0'}))})
});
const api=answerAll=>({
 ...options,manualReview:false,provider:'custom',model:'fake',endpoint:'https://test.invalid',
 request:async(cfg,wire)=>{
  const payload=buildReviewPayload(cfg.context||'',wire,cfg).payload;
  const picks=new Map(payload.targets.map(t=>[t.target_id,t.options[0]||null]));
  return {results:wire.filter(t=>answerAll||t.surface==='경제')
   .map(t=>({t:t.target_id,c:picks.get(t.target_id)}))};
 }
});
const until=async condition=>{
 for(let i=0;i<300;i++){
  if(condition())return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw Error('Timed out waiting for paused EPUB review');
};
async function scenario(firstMode,secondMode){
 const events=[];let resume,localCalls=0,submitted=0;
 const gate=new Promise(resolve=>{resume=resolve});
 const initial=firstMode==='api'?api(false):manual(false);
 const next=secondMode==='api'?api(true):manual(true);
 const start=runSentencePipeline({...base,operationId:'resume-'+firstMode+'-'+secondMode},event=>events.push(event),{
  enabled:true,analyze:async(...args)=>{localCalls++;return analyze(...args);},
  status:async()=>identity,cache:new Map(),persist:async()=>{},
  modelConfig:async()=>({...initial,request:async(...args)=>{submitted++;return initial.request(...args)}}),
  waitForUnfinishedReview:()=>gate,
  continuationModelConfig:async mode=>{
   assert.equal(mode,secondMode);
   return next;
  }
 });
 await until(()=>events.some(e=>e.type==='REVIEW_PAUSED'));
 const firstPause=events.find(e=>e.type==='REVIEW_PAUSED');
 assert.equal(firstPause.unansweredTargets,1,'only the incomplete second word remains');
 assert.equal(events.filter(e=>e.type==='DONE').length,0,'the book cannot be finalized yet');
 assert.equal(localCalls,1,'no re-analysis before continuation');
 assert.ok(submitted>=1,'initial review has actually run');
 resume({mode:secondMode});
 const stats=await start;
 assert.equal(localCalls,1,'the resumed review must not re-run Kiwi/dictionary analysis');
 assert.equal(stats.model_unanswered,0);
 assert.equal(stats.model_conversion_choices,2);
 assert.equal(events.filter(e=>e.type==='REVIEW_CONTINUATION_STARTED').length,1);
 const model=events.filter(e=>e.type==='RESULTS'&&e.source==='model');
 assert.ok(model.some(e=>e.results.some(row=>row.annotations?.some(a=>a.replacement==='經濟'))));
 assert.ok(model.some(e=>e.results.some(row=>row.annotations?.some(a=>a.replacement==='文化'))));
 assert.ok(events.some(e=>e.type==='DONE'&&e.reviewIncomplete===false));
}
test('API can pause after bounded retries, then resume only the missing word manually',async()=>{
 await scenario('api','manual');
});
test('manual mode can preserve accepted answer and resume remaining word through API',async()=>{
 await scenario('manual','api');
});
test('EPUB UI and port protocol provide opt-in continuation rather than restarting analysis',()=>{
 const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
 const html=read('epub.html'),app=read('epub-app.js'),worker=read('service-worker.js');
 assert.match(html,/id="reviewContinuation"/);
 assert.match(html,/id="continuationMode"/);
 assert.match(html,/id="continueReview"/);
 assert.match(app,/allowUserContinuation:true/);
 assert.match(app,/CONTINUE_REVIEW/);
 assert.match(worker,/REVIEW_PAUSED|waitForUnfinishedReview/);
 assert.match(worker,/pendingContinuation/);
 assert.match(worker,/resumeMode/);
 assert.match(app,/job\.releaseReview\(nextMode\)/);
});

test('manual partial validation may be suspended without losing accepted IDs, then returned to book continuation',async()=>{
 const events=[],id='manual-suspend-epub';
 const manualSession=createManualReviewSession({operationId:id,post:e=>events.push(e)});
 const pending=reviewTargets({...options,enableModelReview:true,manualReview:true,
  model:'manual',provider:'manual',context:sentence,
  request:manualSession.request},originals);
 await until(()=>events.some(e=>e.type==='MANUAL_REVIEW_REQUEST'));
 const req=events.find(e=>e.type==='MANUAL_REVIEW_REQUEST');
 const payload=JSON.parse(req.text.slice(req.text.indexOf('{"format":"shared-pools-v5"')));
 const pool=payload.targets[0].options[0];
 assert.ok(pool?.startsWith('p'));
 assert.equal(manualSession.submit({operationId:id,requestId:req.requestId,
  text:JSON.stringify({batch_id:req.requestId,results:[{t:'t0',c:pool}]})}),false);
 const partial=events.filter(e=>e.type==='MANUAL_REVIEW_ERROR').at(-1);
 assert.equal(partial.acceptedCount,1);
 assert.equal(manualSession.suspend(),true);
 const result=await pending;
 assert.equal(result.suspended,true);
 assert.equal(result.accepted.length,1);
 assert.equal(result.accepted[0].target.target_id,'orig0');
 assert.equal(result.unresolved.length,1);
 assert.equal(result.unresolved[0].target_id,'orig1');
 assert.ok(events.some(e=>e.type==='MANUAL_REVIEW_PAUSED'));
});

test('preflight-parked manual group can start its first model review in API mode without another local pass',async()=>{
 const events=[];
 let releaseReview,localCalls=0,manualCalls=0,apiCalls=0;
 const reviewGate=new Promise(resolve=>{releaseReview=resolve});
 const initial=manual(true),switched=api(true);
 const running=runSentencePipeline({...base,operationId:'parked-manual-to-api',deferReview:true},
  event=>events.push(event),{
   enabled:true,
   analyze:async(...args)=>{localCalls++;return analyze(...args);},
   status:async()=>identity,cache:new Map(),persist:async()=>{},
   modelConfig:async()=>({...initial,request:async(...args)=>{
    manualCalls++;return initial.request(...args);
   }}),
   continuationModelConfig:async mode=>{
    assert.equal(mode,'api');
    return {...switched,request:async(...args)=>{
     apiCalls++;return switched.request(...args);
    }};
   },
   waitForReviewStart:()=>reviewGate,
   waitForUnfinishedReview:()=>Promise.reject(Error('unexpected pause after complete API switch'))
  });
 await until(()=>events.some(e=>e.type==='REVIEW_PLAN'));
 assert.equal(localCalls,1);
 assert.equal(manualCalls,0);
 assert.equal(apiCalls,0);
 releaseReview({mode:'api'});
 const stats=await running;
 assert.equal(localCalls,1,'unstarted group must not reanalyse text');
 assert.equal(manualCalls,0,'no manual prompt should be emitted for switched group');
 assert.ok(apiCalls>0,'provider switched before first request');
 assert.equal(stats.model_unanswered,0);
 assert.equal(stats.model_conversion_choices,2);
 assert.ok(events.some(e=>e.type==='DIAGNOSTIC'&&e.diagnostic?.stage==='epub-preflight-mode-switch'));
});
