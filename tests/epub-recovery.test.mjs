import test from 'node:test';
import assert from 'node:assert/strict';
import {manualPromptPayload,manualRequestIdentity,sameManualTargets,transferManualAnswer} from '../epub-recovery.js';
const body=(id,surface='원잠')=>({
 format:'shared-pools-v5',batch_id:id,
 sentences:[{sentence_id:'s0',text:surface+' 관련 소식'}],
 candidates:[{candidate_id:'p1',type:'hanja',replacement:'原潛',definitions:['submarine']}],
 targets:[{target_id:'t0',surface,options:['p1'],sentence_id:'s0'}],
 origin_mode:'open-origin',allowed_origin_types:['hanja']
});
const request=(id,surface)=>({requestId:id,text:'Review this batch:\n'+JSON.stringify(body(id,surface))});

test('unchanged Hanja/loanword candidate pools accept old JSON with old batch ID after engine restart',()=>{
 const old=request('old-batch'),next=request('new-batch');
 assert.ok(manualPromptPayload(old.text));
 assert.ok(manualRequestIdentity(old));
 assert.ok(sameManualTargets(old,next));
 const response=transferManualAnswer('{"batch_id":"old-batch","results":[{"t":"t0","c":"p1"}]}',old,next);
 assert.deepEqual(JSON.parse(response),{batch_id:'new-batch',results:[{t:'t0',c:'p1'}]});
});

test('already validated choices are merged with a later correction after disconnect',()=>{
 const old=request('old-batch'),next=request('new-batch');
 const response=transferManualAnswer('{"batch_id":"old-batch","results":[{"t":"t1","c":null}]}',old,next,[{t:'t0',c:'p1'}]);
 assert.deepEqual(JSON.parse(response).results,[{t:'t0',c:'p1'},{t:'t1',c:null}]);
});

test('model JSON code fence, bare result arrays, and missing batch wrapper recover safely',()=>{
 const old=request('old-batch'),next=request('new-batch');
 const fence=String.fromCharCode(96).repeat(3)+'json\n{"batch_id":"old-batch","results":[{"t":"t0","c":null}]}\n'+String.fromCharCode(96).repeat(3);
 for(const input of [fence,'[{"t":"t0","c":null}]','{"results":[{"t":"t0","c":null}]}']){
  const rebound=transferManualAnswer(input,old,next);
  assert.equal(JSON.parse(rebound).batch_id,'new-batch');
 }
});

test('reject cross-context stale answers, changed candidate spellings, foreign batches and malformed JSON',()=>{
 const old=request('old-batch'),newer=request('new-batch','학교');
 assert.equal(sameManualTargets(old,newer),false);
 assert.equal(transferManualAnswer('{"batch_id":"old-batch","results":[]}',old,newer),null);
 const modified=request('new-batch');
 modified.text=modified.text.replace('原潛','原蠶');
 assert.equal(sameManualTargets(old,modified),false);
 assert.equal(transferManualAnswer('{"batch_id":"foreign","results":[]}',old,request('new-batch')),null);
 assert.equal(transferManualAnswer('not json',old,request('new-batch')),null);
});
