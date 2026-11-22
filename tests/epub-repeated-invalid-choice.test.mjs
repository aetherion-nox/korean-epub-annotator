import test from 'node:test';
import assert from 'node:assert/strict';
import {epubSafeCorrectionTarget,epubInvalidChoiceReason} from '../epub-choice-correction.js';
import {reviewTargets} from '../choice-review.js';
import {buildReviewPayload,buildReviewInstructions} from '../review-payload.js';

const keep={choice_id:null,type:'keep',replacement:'경제',entry_id:null,definitions:[]};
const t={target_id:'b0t1',start:0,end:2,surface:'경제',context:'경제',options:[keep]};
test('EPUB correction includes explicit per-target legal IDs and forbids imaginary p0',()=>{
 const options={epubBookSession:true,dictionaryCorrectionOnly:true,experimentalHanja:true};
 const packed=buildReviewPayload('경제',[t],options).payload;
 assert.deepEqual(packed.targets[0].allowed_p,[]);
 assert.deepEqual(packed.targets[0].options,[]);
 assert.match(buildReviewInstructions(options),/allowed_p/);
 assert.equal(epubInvalidChoiceReason(t,'c0',options),'choice_not_in_target_options');
 const web=buildReviewPayload('경제',[t],{dictionaryCorrectionOnly:true}).payload;
 assert.equal(Object.hasOwn(web.targets[0],'allowed_p'),false,'the website prompt remains unchanged');
});
test('EPUB correction preserves POS-legal dictionary choices despite phonetic mismatch',()=>{
 const options={hanjaReadingCheck:true,reviewPosFilter:false};
 const source={...t,options:[keep,
  {choice_id:'c0',type:'hanja',replacement:'經濟',entry_id:1,definitions:['economy']},
  {choice_id:'c1',type:'hanja',replacement:'愛情',entry_id:2,definitions:['not economy']}]};
 const safe=epubSafeCorrectionTarget(source,options);
 assert.ok(safe.options.some(o=>o.choice_id==='c0'));
 assert.ok(safe.options.some(o=>o.choice_id==='c1'), 'dictionary candidates are never removed by experimental phonetics');
 assert.equal(epubInvalidChoiceReason(source,'c1',options),'choice_other_validation_failure');
});
test('EPUB strict API stops after two identical invalid responses and avoids useless single-target retries',async()=>{
 const events=[],requests=[];
 const result=await reviewTargets({
  enableModelReview:true,provider:'custom',model:'test',
  epubBookSession:true,epubBookRunId:'stagnant-book',epubApiConcurrency:1,
  retryInvalidDictionaryChoices:true,experimentalHanja:true,reviewPosFilter:false,
  request:async(config,wire)=>{
   requests.push({correction:config.dictionaryCorrectionOnly===true,wire});
   return {results:wire.map(t=>({t:t.target_id,c:'c0'}))};
  },
  onDiagnostic:ev=>events.push(ev)
 },[t]);
 assert.equal(result.unresolved.length,1);
 assert.equal(result.accepted.length,0,'strict mode must never invent a null answer');
 assert.equal(requests.length,2,'first invalid response + one repeated invalid correction, then stop');
 assert.equal(requests[0].correction,false);
 assert.ok(requests.slice(1).every(r=>r.correction));
 assert.ok(requests.slice(1).every(r=>r.wire[0].options.every(o=>o.type==='keep')));
 assert.ok(events.some(e=>e.stage==='epub-repeated-invalid'));
});
test('EPUB still accepts an actual null on the targeted correction rather than dropping it',async()=>{
 const events=[];
 let calls=0;
 const result=await reviewTargets({
  enableModelReview:true,provider:'custom',model:'test',
  epubBookSession:true,epubBookRunId:'safe-null-book',epubApiConcurrency:1,
  retryInvalidDictionaryChoices:true,experimentalHanja:true,reviewPosFilter:false,
  request:async(config,wire)=>{
   calls++;
   return {results:wire.map(row=>({t:row.target_id,c:config.dictionaryCorrectionOnly?null:'c0'}))};
  },onDiagnostic:event=>events.push(event)
 },[t]);
 assert.equal(calls,2);
 assert.equal(result.unresolved.length,0);
 assert.equal(result.accepted[0].option.type,'keep');
});


test('EPUB remembers repeated illegal answers across fallback and user continuation, without blocking manual rescue',async()=>{
 const history=new Map(),events=[];
 let apiCalls=0;
 const options={enableModelReview:true,provider:'custom',model:'same-test-model',endpoint:'https://example.test/v1',
  epubBookSession:true,epubBookRunId:'book-history',epubApiConcurrency:1,
  rejectedChoiceHistory:history,retryInvalidDictionaryChoices:true,experimentalHanja:true,
  request:async(_config,wire)=>{apiCalls++;return {results:wire.map(row=>({t:row.target_id,c:'禁忌忌'}))};},
  onDiagnostic:e=>events.push(e)};
 const first=await reviewTargets(options,[t]);
 assert.equal(first.unresolved.length,1);
 assert.equal(apiCalls,2,'stop after the first repeated rejected answer');
 const again=await reviewTargets(options,[t]);
 assert.equal(again.unresolved.length,1);
 assert.equal(apiCalls,2,'same model must not query a third time on user continuation');
 assert.ok(events.some(e=>e.stage==='epub-repeated-invalid'));
 const manual=await reviewTargets({...options,manualReview:true,
  request:async()=>({results:[{t:'b0t1',c:null}]})},[t]);
 assert.equal(manual.unresolved.length,0,'manual null is always a legitimate rescue');
 assert.equal(manual.accepted[0].option.type,'keep');
});
