import test from 'node:test';
import assert from 'node:assert/strict';
import {runSentencePipeline} from '../annotation-pipeline.js';
import {buildReviewPayload} from '../review-payload.js';

const identity={engine_version:'epub-retry-test',dictionary_fingerprint:'epub-retry-test',dictionary_metadata:{}};
const sentence='경제, 교육, 문화';
const candidates=[
 ['경제',0,'經濟'],['교육',4,'敎育'],['문화',8,'文化']
];
const analyze=async()=>({...identity,annotations:[],targets:candidates.map(([surface,start,replacement],i)=>({
 target_id:'t'+i,start,end:start+surface.length,surface,context:sentence,
 options:[{choice_id:null,type:'keep',replacement:surface,entry_id:null,definitions:[]},
 {choice_id:'c0',type:'hanja',replacement,entry_id:i+1,definitions:['valid']}
 ]})),stats:{pending:3,local_determined:0}});
const base={operationId:'epub-api-resume',epubBookSession:true,epubBookRunId:'retry-book',epubApiConcurrency:2,
 smartSegmentation:true,deferReview:true,sentences:[{id:'ep0_s0',text:sentence}],
 context:sentence,modes:{hanja:true,loanword:false},reviewLocalConversions:true};
const wait=async predicate=>{
 for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}
 throw Error('timeout waiting for EPUB plan');
};
async function run(configOverrides={}){
 const events=[];let releaseGate;
 const gate=new Promise(resolve=>{releaseGate=resolve});
 let calls=0;
 const modelConfig=async()=>({
  model:'test',provider:'custom',endpoint:'test://api',batchContextTier:'32k',
  smartSegmentation:true,reviewPosFilter:false,retryInvalidDictionaryChoices:true,
  request:async(config,wire)=>{
   calls++;
   if(configOverrides.permanent){const error=Error('permanent');error.permanent=true;throw error;}
   if(configOverrides.discardInvalidReviewResults)return {results:[]};
   return config.smartSegmentation?{results:[]}:
    {results:buildReviewPayload(config.context||'',wire,config).payload.targets.map(t=>({t:t.target_id,c:t.options[0]}))};
  },...configOverrides
 });
 const task=runSentencePipeline(base,event=>events.push(event),{
  status:async()=>identity,analyze,enabled:true,modelConfig,
  cache:new Map(),persist:async()=>{},waitForReviewStart:()=>gate
 });
 await wait(()=>events.some(e=>e.type==='REVIEW_PLAN'));
 releaseGate();
 const result=await task;
 return {events,result,calls};
}
test('EPUB waits for initial batches and then retries unfinished targets using a pooled compact batch',async()=>{
 const {events,result,calls}=await run();
 assert.equal(calls,2,'one initial API batch plus one compact pooled retry');
 assert.equal(result.model_unanswered,0);
 const done=events.find(e=>e.type==='DONE');
 assert.equal(done.reviewIncomplete,false);
 assert.equal(done.unansweredTargets,0);
 assert.ok(events.some(e=>e.type==='DIAGNOSTIC'&&e.diagnostic.stage==='epub-pooled-retry'));
 assert.ok(events.filter(e=>e.type==='RESULTS'&&e.source==='model').some(e=>e.results.some(r=>r.annotations?.length)));
});
test('EPUB permanent API errors are not retried indefinitely',async()=>{
 const {events,result,calls}=await run({permanent:true});
 assert.equal(calls,1);
 assert.equal(result.model_unanswered,3);
 assert.ok(events.find(e=>e.type==='DONE')?.reviewIncomplete);
});
test('discard-invalid strategy does not accidentally start strict continuation',async()=>{
 const {result,calls}=await run({retryInvalidDictionaryChoices:false,discardInvalidReviewResults:true});
 assert.equal(calls,1);
 assert.equal(result.model_unanswered,0);
});
