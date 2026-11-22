import test from 'node:test';
import assert from 'node:assert/strict';
import {buildManualPrompt,buildReviewPayload} from '../review-payload.js';
import {describeBatchBudget} from '../batch-budget.js';

const keep=surface=>({choice_id:null,type:'keep',replacement:surface,entry_id:null,definitions:[]});
const convertible=(choice_id,replacement)=>({choice_id,type:'hanja',replacement,entry_id:500,definitions:['dictionary sense']});
const paragraph1='미국이 경제 정책을 검토했다.';
const paragraph2='북한은 새로운 조건을 요구했다.';
const targets=[
 {target_id:'t0',context:paragraph1,start:4,end:6,surface:'경제',
  adjacent_context:{before:'이전 뉴스 문단',after:paragraph2},
  options:[keep('경제'),convertible('c0','經濟')]},
 {target_id:'t1',context:paragraph2,start:8,end:10,surface:'조건',
  adjacent_context:{before:paragraph1,after:'마지막 문단'},
  options:[keep('조건'),convertible('c1','條件')]}
];
const cfg={reviewPosFilter:false,smartSegmentation:false};
const manualData=(prompt)=>JSON.parse(prompt.slice(prompt.indexOf('{"format":"shared-pools-v5"')));

test('EPUB v0.1.18: non-smart web 1.2.12 context contract for API and manual',()=>{
 const {payload}=buildReviewPayload(paragraph1+'\n'+paragraph2,targets,cfg);
 assert.equal(payload.context,undefined,'top-level duplicate full context must not be serialized');
 assert.deepEqual(payload.sentences.map(x=>x.text),[paragraph1,paragraph2]);
 assert.deepEqual(payload.sentences.map(x=>x.sentence_id),['s0','s1']);
 assert.deepEqual(payload.sentences.map(x=>x.adjacent_context),targets.map(x=>x.adjacent_context));
 assert.deepEqual(payload.targets.map(x=>x.sentence_id),['s0','s1']);
 assert.equal(payload.targets.every(x=>!('context' in x)),true);
 assert.equal(payload.targets[0].surface,'경제');
 assert.ok(payload.targets[0].options.length>0);
 assert.equal(payload.candidates.length,2);
 const manual=manualData(buildManualPrompt(paragraph1+'\n'+paragraph2,targets,'batch-018',cfg));
 assert.equal(manual.context,undefined);
 assert.deepEqual(manual.sentences,payload.sentences);
 assert.deepEqual(manual.targets,payload.targets);
 assert.deepEqual(manual.candidates,payload.candidates);
 assert.equal(manual.batch_id,'batch-018');
});

test('EPUB-specific rejected-choice reasons and allowed candidate pools survive context dedup',()=>{
 const config={...cfg,epubBookSession:true,dictionaryCorrectionOnly:true,epubRejectedChoices:{
  t0:[{c:'invalid',reason:'hanja_alignment_or_boundary'},
      {c:'p99',reason:'choice_not_in_target_options',scope:'previous_request_only'}]
 }};
 const {payload}=buildReviewPayload('duplicated whole-book context',targets,config);
 assert.equal(payload.context,undefined);
 assert.deepEqual(payload.targets[0].rejected_choices,config.epubRejectedChoices.t0);
 assert.deepEqual(payload.targets[0].allowed_p,payload.targets[0].options);
 assert.equal(payload.targets[1].rejected_choices,undefined);
 assert.deepEqual(payload.sentences.map(s=>s.text),[paragraph1,paragraph2]);
});

test('smart segmentation retains complete Kiwi/protected span data and never duplicates full context',()=>{
 const smartTarget={...targets[0],repair_sentence_key:'chapter-1',repair_context:{
  kiwi_tokens:[{form:'미국',tag:'NNP',start:0,end:2},{form:'이',tag:'JKS',start:2,end:3},
   {form:'경제',tag:'NNG',start:4,end:6}],
  protected_ranges:[[0,2]]}};
 const {payload}=buildReviewPayload('whole-book context',[smartTarget],{...cfg,smartSegmentation:true});
 assert.equal(payload.context,undefined);
 assert.deepEqual(payload.sentences[0].kiwi_tokens,[['미국','NNP',0,2],['이','JKS',2,3],['경제','NNG',4,6]]);
 assert.deepEqual(payload.sentences[0].protected_ranges,[[0,2]]);
 assert.equal(payload.sentences[0].text,paragraph1);
 assert.equal(payload.targets[0].sentence_id,'s0');
});

test('API and manual token budgets share the deduplicated payload builder',()=>{
 const context=paragraph1+'\n'+paragraph2;
 const api=describeBatchBudget(context,targets,{tier:'128k',manual:false,reviewPosFilter:false});
 const manual=describeBatchBudget(context,targets,{tier:'128k',manual:true,reviewPosFilter:false});
 assert.ok(api.inputTokens>0&&manual.inputTokens>0);
 assert.ok(api.totalTokens<=api.contextTokens);
 assert.ok(manual.totalTokens<=manual.contextTokens);
});
