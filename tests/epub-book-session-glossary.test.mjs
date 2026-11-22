import test from 'node:test';
import assert from 'node:assert/strict';
import {runSentencePipeline} from '../annotation-pipeline.js';
import {buildReviewPayload} from '../review-payload.js';
import {restoreSessionHanjaGlossary,snapshotSessionHanjaGlossary,createSessionHanjaGlossary} from '../session-hanja-glossary.js';

const identity={engine_version:'book-test',dictionary_fingerprint:'book-test',dictionary_metadata:{}};
const analyze=async text=>({engine_version:'book-test',dictionary_fingerprint:'book-test',annotations:[],targets:[],stats:{pending:0,local_determined:0}});
const config=async()=>({model:'test',provider:'custom',endpoint:'https://invalid.test',reviewPosFilter:false,batchContextTier:'32k',
 request:async(config,targets)=>({results:buildReviewPayload(config.context||'',targets,config).payload.targets.map(t=>({t:t.target_id,c:t.options[0]}))})});
const until=async check=>{
 for(let i=0;i<250;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,4));}
 throw Error('EPUB plan not delivered');
};
const createRun=(operationId,text,sessionHanjaSeed=[])=>{
 const events=[];let release;
 const gate=new Promise(done=>{release=done});
 const task=runSentencePipeline({
  operationId,epubBookSession:true,sessionHanjaSeed,deferReview:true,
  sentences:[{id:operationId,text}],context:text,modes:{hanja:true,loanword:false}
 },event=>{events.push(event)},{
  enabled:true,status:async()=>identity,analyze,modelConfig:config,
  persist:async()=>{},cache:new Map(),waitForReviewStart:()=>gate
 });
 return {events,release,task,plan:async()=>{await until(()=>events.some(e=>e.type==='REVIEW_PLAN'));return events.find(e=>e.type==='REVIEW_PLAN')}};
};

test('EPUB author glossary is carried forward across independent preplanned worker operations',async()=>{
 const first=createRun('epub-chunk-0','백영관(白靈觀)이 나왔다.');
 const p0=await first.plan();
 assert.equal(p0.plannedBatches,0);
 assert.deepEqual(p0.sessionHanjaSnapshot.map(x=>[x.surface,x.hanja]),[['백영관','白靈觀']]);
 const later=createRun('epub-chunk-1','다음 장에 백영관을 찾아갔다.',p0.sessionHanjaSnapshot);
 const p1=await later.plan();
 assert.equal(p1.plannedTargets,1,'the later group inherits the new origin target before any LLM request');
 assert.equal(p1.plannedBatches,1);
 assert.deepEqual(p1.sessionHanjaSnapshot,p0.sessionHanjaSnapshot);
 assert.equal(later.events.filter(e=>e.type==='MODEL_BATCH_START').length,0);
 first.release();later.release();
 await Promise.all([first.task,later.task]);
 const end=later.events.find(e=>e.type==='DONE');
 assert.equal(end.reviewIncomplete,false);
 assert.equal(end.stats.session_hanja_new_targets,1);
 assert.ok(later.events.some(e=>e.type==='RESULTS'&&e.source==='model'&&
  e.results.some(r=>r.annotations?.some(a=>a.replacement==='白靈觀'))));
});

test('EPUB later-chapter evidence does not annotate earlier chunks, or leak into another book',async()=>{
 const before=createRun('before-source','아직 백영관을 몰랐다.');
 const plan=await before.plan();
 assert.deepEqual(plan.sessionHanjaSnapshot,[]);
 assert.equal(plan.plannedTargets,0);
 before.release();await before.task;
 const another=createRun('fresh-book','백영관을 알았다.');
 const fresh=await another.plan();
 assert.equal(fresh.plannedTargets,0);
 another.release();await another.task;
});

test('EPUB imported author spellings retain multiple cited variants, but malformed handoff is rejected',()=>{
 const empty=createSessionHanjaGlossary();
 assert.deepEqual(snapshotSessionHanjaGlossary(empty),[]);
 assert.throws(()=>restoreSessionHanjaGlossary([{surface:'백영관',hanja:'wrong',citations:['bad']}]),/Invalid/);
 assert.throws(()=>restoreSessionHanjaGlossary([{surface:'백영관',hanja:'白靈觀',citations:[]}]),/Invalid/);
 const restored=restoreSessionHanjaGlossary([{surface:'백영관',hanja:'白靈觀',citations:['백영관(白靈觀)']}]);
 assert.deepEqual(snapshotSessionHanjaGlossary(restored),[{surface:'백영관',hanja:'白靈觀',citations:['백영관(白靈觀)']}]);
});
