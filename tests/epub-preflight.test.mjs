import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runSentencePipeline} from '../annotation-pipeline.js';
import {createManualReviewSession} from '../manual-review.js';
import {buildReviewPayload} from '../review-payload.js';

const identity={engine_version:'epub-preflight',dictionary_fingerprint:'dict-v1',dictionary_metadata:{}};
const sentence='경제를 논의한다.';
const target={target_id:'t0',start:0,end:2,surface:'경제',context:sentence,
 options:[{choice_id:null,type:'keep',replacement:'경제',entry_id:null,definitions:[]},
  {choice_id:'c0',type:'hanja',replacement:'經濟',entry_id:401,definitions:['economy']}]};
const fakeAnalyze=async()=>({...identity,annotations:[],targets:[target],stats:{pending:1,local_determined:0}});
const settings={experimentalHanja:false,experimentalLoanword:false,smartSegmentation:false,reviewPosFilter:false};
const until=async predicate=>{
 for(let n=0;n<200;n++){
  if(predicate())return;
  await new Promise(r=>setTimeout(r,5));
 }
 throw Error('Plan or manual review did not arrive');
};

test('EPUB single-pass API planning returns one batch, then invokes one API call without rerunning local analysis',async()=>{
 const cache=new Map(),all=[];
 let requestCalls=0,localCalls=0,release;
 const gate=new Promise(resolve=>{release=resolve});
 const config=async()=>({...settings,model:'test',endpoint:'test://api',
  request:async(cfg,targets)=>{requestCalls++;return {results:buildReviewPayload(cfg.context||'',targets,cfg).payload.targets.map(t=>({t:t.target_id,c:t.options[0]}))};}});
 const base={operationId:'plan-api',sentences:[{id:'ep0_s0',text:sentence}],
  modes:{hanja:true,loanword:false},reviewLocalConversions:true,deferReview:true};
 const options={status:async()=>identity,analyze:async(...args)=>{localCalls++;return fakeAnalyze(...args)},
  enabled:true,modelConfig:config,cache,persist:async()=>{},waitForReviewStart:()=>gate};
 const running=runSentencePipeline(base,e=>all.push(e),options);
 await until(()=>all.some(e=>e.type==='REVIEW_PLAN'));
 const plan=all.find(e=>e.type==='REVIEW_PLAN');
 assert.equal(plan.requestKind,'api');
 assert.equal(plan.plannedBatches,1);
 assert.equal(plan.plannedTargets,1);
 assert.equal(requestCalls,0);
 assert.equal(localCalls,1);
 assert.equal(all.filter(e=>e.type==='MODEL_BATCH_START').length,0);
 assert.equal(all.filter(e=>e.type==='MANUAL_REVIEW_REQUEST').length,0);
 release();await running;
 assert.equal(requestCalls,1);
 assert.equal(localCalls,1,'no second local pass after review plan is released');
 assert.equal(all.filter(e=>e.type==='REVIEW_PLAN').length,1);
 assert.equal(all.filter(e=>e.type==='MODEL_BATCH_START').length,plan.plannedBatches);
 assert.equal(all.filter(e=>e.type==='MODEL_BATCH_DONE').length,plan.plannedBatches);
 assert.ok(all.some(e=>e.type==='DONE'&&e.preflight!==true));
});
test('EPUB single-pass manual planning emits no prompt before all-book release',async()=>{
 const cache=new Map(),history=[];
 let localCalls=0,release;
 const gate=new Promise(resolve=>{release=resolve});
 const session=createManualReviewSession({operationId:'manual-batch',post:event=>{
  history.push(event);
  if(event.type==='MANUAL_REVIEW_REQUEST'){
   const prompt=JSON.parse(event.text.slice(event.text.indexOf('{"format":"shared-pools-v5"')));
   const pooled=new Map(prompt.targets.map(t=>[t.target_id,t.options[0]??null]));
   const answer={batch_id:event.requestId,
    results:(event.bindings||[]).map(b=>({t:b.target_id,c:pooled.get(b.target_id)}))};
   queueMicrotask(()=>session.submit({operationId:'manual-batch',
    requestId:event.requestId,text:JSON.stringify(answer)}));
  }
 }});
 const base={operationId:'manual-batch',sentences:[{id:'ep0_s0',text:sentence}],
  modes:{hanja:true},reviewLocalConversions:true,deferReview:true};
 const options={status:async()=>identity,analyze:async(...args)=>{localCalls++;return fakeAnalyze(...args)},
  enabled:true,modelConfig:async()=>({...settings,manualReview:true,request:session.request,batchContextTier:'32k'}),
  cache,persist:async()=>{},waitForReviewStart:()=>gate};
 const running=runSentencePipeline(base,e=>history.push(e),options);
 await until(()=>history.some(e=>e.type==='REVIEW_PLAN'));
 const plan=history.find(e=>e.type==='REVIEW_PLAN');
 assert.equal(plan.requestKind,'manual');
 assert.equal(plan.plannedBatches,1);
 assert.equal(history.filter(e=>e.type==='MANUAL_REVIEW_REQUEST').length,0);
 assert.equal(history.filter(e=>e.type==='MANUAL_REVIEW_PLAN').length,0);
 assert.equal(localCalls,1);
 release();await running;
 assert.equal(history.filter(e=>e.type==='MANUAL_REVIEW_REQUEST').length,plan.plannedBatches);
 assert.equal(localCalls,1);
});
test('EPUB UI holds each live worker session instead of restarting the analysis pipeline',()=>{
 const app=readFileSync(new URL('../epub-app.js',import.meta.url),'utf8');
 assert.match(app,/const planning=new Promise/);
 assert.match(app,/const reviewGate=new Promise/);
 assert.match(app,/job\.task=runChunk\(group,context,book,index,modes,progressive,false,true/);
 assert.match(app,/const planned=await planning/);
 assert.match(app,/for\(const job of parkedJobs\)/);
 assert.match(app,/job\.state='running';job\.releaseReview\(\)/);
 assert.match(app,/await settle\(parkedJobs\)/);
 assert.match(app,/waitForBookContinuation/);
 assert.match(app,/job\.task\.then/);
 assert.doesNotMatch(app,/runChunk\(group,context,book,index,modes,false,true\)/);
 assert.match(app,/totalPlannedReviewRequests=plannedByChunk\.reduce/);
 assert.match(app,/REVIEW_PLAN/);
 assert.match(app,/RUN_REVIEW/);
 const html=readFileSync(new URL('../epub.html',import.meta.url),'utf8');
 assert.match(html,/id="requestPlan"/);
 const worker=readFileSync(new URL('../service-worker.js',import.meta.url),'utf8');
 assert.match(worker,/waitForReviewStart/);
 assert.match(worker,/message\?\.type==='RUN_REVIEW'/);
});
