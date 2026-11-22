import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewTargets} from '../choice-review.js';
import {buildReviewPayload,buildReviewInstructions} from '../review-payload.js';
import {prepareManualRequest} from '../manual-review.js';
import {
 epubRejectedModelKey,epubRejectedChoicesForTarget,
 recordEpubRejectedChoice,epubRepeatedInvalidChoice
} from '../epub-rejection-feedback.js';

const target=(surface='경제',wire='b0t1')=>({
 target_id:wire,original_target_id:'original-1',source_sentence_id:'chapter-s1',
 start:0,end:surface.length,surface,context:surface,
 options:[{choice_id:null,type:'keep',replacement:surface,entry_id:null,definitions:[]}]
});
const config={
 enableModelReview:true,provider:'custom',model:'model-a',
 endpoint:'https://example.test/v1',epubBookSession:true,epubBookRunId:'book',
 epubApiConcurrency:1,reviewPosFilter:false,
 retryInvalidDictionaryChoices:true,experimentalHanja:true,
 discardInvalidReviewResults:false
};
const packed=(cfg,wire)=>buildReviewPayload(cfg.context||'',wire,cfg).payload;

test('EPUB correction tells the model that c0 does not exist, then accepts explicit null',async()=>{
 const history=new Map(),seen=[];
 const result=await reviewTargets({...config,rejectedChoiceHistory:history,
  request:async(cfg,wire)=>{
   seen.push(packed(cfg,wire));
   return {results:wire.map(t=>({t:t.target_id,c:seen.length===1?'c0':null}))};
  }},[target()]);
 assert.equal(result.unresolved.length,0);
 assert.equal(seen.length,2);
 assert.equal(seen[0].targets[0].rejected_choices,undefined);
 assert.deepEqual(seen[1].targets[0].rejected_choices,
  [{c:'c0',reason:'choice_not_in_target_options'}]);
 assert.match(buildReviewInstructions({...config,dictionaryCorrectionOnly:true}),/validation reasons|validator|rejected_choices/i);
});

test('EPUB directly rejected Hanja/loanword origins include their actual validation reason',async()=>{
 for(const [surface,choice,flags,reason] of [
  ['경제','禁忌忌',{experimentalHanja:true,experimentalLoanword:false},'hanja_alignment_or_boundary'],
  ['터부도','_taboo',{experimentalHanja:false,experimentalLoanword:true},'loanword_script_or_boundary'],
  ['터부도','taboo가',{experimentalHanja:false,experimentalLoanword:true},'embedded_hangul_alignment_or_boundary']
 ]){
  const history=new Map(),shown=[];
  await reviewTargets({...config,...flags,rejectedChoiceHistory:history,
   request:async(cfg,wire)=>{
    shown.push(packed(cfg,wire));
    return {results:[{t:wire[0].target_id,c:shown.length===1?choice:null}]};
   }},[target(surface)]);
  assert.equal(shown.length,2,choice+' must be corrected once');
  assert.deepEqual(shown[1].targets[0].rejected_choices,[{c:choice,reason}]);
 }
});

test('EPUB continuation with a different model sees earlier rejection reason and recovered wire ID',async()=>{
 const prior=target('경제','b0t757');
 const history=new Map();
 await reviewTargets({...config,epubInitialReview:true,rejectedChoiceHistory:history,
  request:async(_cfg,wire)=>({results:[{t:wire[0].target_id,c:'禁忌忌'}]})
 },[prior]);
 const reconnected=new Map([...history.entries()].map(([key,record])=>
  [key,JSON.parse(JSON.stringify(record))]));
 const later=target('경제','retry4t0');
 const seen=[];
 const result=await reviewTargets({...config,model:'different-model',
  epubInitialReview:true,rejectedChoiceHistory:reconnected,
  request:async(cfg,wire)=>{
   seen.push(packed(cfg,wire));
   return {results:[{t:wire[0].target_id,c:null}]};
  }},[later]);
 assert.equal(result.unresolved.length,0);
 assert.deepEqual(seen[0].targets[0].rejected_choices,
  [{c:'禁忌忌',reason:'hanja_alignment_or_boundary'}]);
 assert.ok([...reconnected.values()][0].counts['禁忌忌'].reason);
});

test('A-B-A invalid origin remains stopped, while old pooled p IDs are not permanently banned',()=>{
 const t=target(),history=new Map();
 recordEpubRejectedChoice(history,config,t,'禁忌忌','hanja_alignment_or_boundary');
 recordEpubRejectedChoice(history,config,t,'_taboo','loanword_script_or_boundary');
 recordEpubRejectedChoice(history,config,t,'禁忌忌','hanja_alignment_or_boundary');
 assert.equal(epubRepeatedInvalidChoice(history,config,t),true);
 assert.deepEqual(epubRejectedChoicesForTarget(history,t).map(x=>x.reason),[
  'hanja_alignment_or_boundary','loanword_script_or_boundary'
 ]);
 const h2=new Map();
 recordEpubRejectedChoice(h2,config,t,'p0','invalid_pooled_choice_id');
 recordEpubRejectedChoice(h2,config,t,'p0','invalid_pooled_choice_id');
 assert.equal(epubRepeatedInvalidChoice(h2,config,t),false,
  'a new request may reuse p0 for a different dictionary sense');
 assert.deepEqual(epubRejectedChoicesForTarget(h2,t),[
  {c:'p0',reason:'invalid_pooled_choice_id',scope:'previous_request_only'}]);
});

test('EPUB restores v0.1.15 numeric history without pretending the exact reason was saved',()=>{
 const t=target();const key=epubRejectedModelKey(config,t);
 const history=new Map([[key,{counts:{'禁忌忌':2},last:'禁忌忌'}]]);
 assert.equal(epubRepeatedInvalidChoice(history,config,t),true);
 assert.deepEqual(epubRejectedChoicesForTarget(history,t),[
  {c:'禁忌忌',reason:'previously_rejected'}]);
});

test('Manual EPUB continuation also includes source-bound past mistakes in the pasted prompt',()=>{
 const t=target(),history=new Map();
 recordEpubRejectedChoice(history,config,t,'禁忌忌','hanja_alignment_or_boundary');
 const payload=prepareManualRequest({...config,context:'경제',manualReview:true,
  epubRejectedChoices:{[t.target_id]:epubRejectedChoicesForTarget(history,t)}},[t]);
 assert.match(payload.text,/"rejected_choices"/);
 assert.match(payload.text,/"hanja_alignment_or_boundary"/);
 assert.match(payload.text,/"禁忌忌"/);
});
