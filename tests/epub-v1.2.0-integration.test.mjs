import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ENGINE_SWITCH_DEFAULTS,engineSwitchValues} from '../engine-defaults.js';
import {validateChoices} from '../choice-review.js';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const manifest=JSON.parse(read('manifest.json'));
const pkg=JSON.parse(read('package.json'));
const keep={choice_id:null,type:'keep',replacement:'경제',entry_id:null,definitions:[]};
const sense={choice_id:'c0',type:'hanja',replacement:'經濟',entry_id:42,definitions:['economy']};
const target={target_id:'t0',surface:'경제',context:'경제',start:0,end:2,options:[keep,sense]};
const config={retryInvalidDictionaryChoices:true,discardInvalidReviewResults:false,reviewPosFilter:false};

test('EPUB extension ships the web 1.2.8 strict-review core without website injection',()=>{
 assert.equal(manifest.version,'1.0.1');
 assert.equal(pkg.version,manifest.version);
 assert.equal(manifest.content_scripts,undefined);
 assert.equal(manifest.action.default_popup,undefined);
 assert.match(read('service-worker.js'),/1\.2\.8-epub-pos-independent-pools/);
 assert.match(read('service-worker.js'),/RUN_REVIEW/);
 assert.match(read('epub-app.js'),/requestPlan/);
 assert.match(read('epub-core.js'),/application\/epub\+zip/);
});

test('EPUB settings inherit mutually exclusive strict retry/discard defaults',()=>{
 assert.equal(ENGINE_SWITCH_DEFAULTS.retryInvalidDictionaryChoices,true);
 assert.equal(ENGINE_SWITCH_DEFAULTS.discardInvalidReviewResults,false);
 for(const saved of [{},{retryInvalidDictionaryChoices:false,discardInvalidReviewResults:false},
                    {retryInvalidDictionaryChoices:true,discardInvalidReviewResults:true}]){
  const s=engineSwitchValues(saved);
  assert.equal(Number(s.retryInvalidDictionaryChoices)+Number(s.discardInvalidReviewResults),1);
 }
});

test('EPUB manual/API review only implicitly retains Korean on explicit null unless discard is on',()=>{
 for(const c of [null,'null','NULL','NuLl']){
  const r=validateChoices([target],{results:[{t:'t0',c}]},config);
  assert.equal(r.accepted[0].option.choice_id,null);
  assert.equal(r.unresolved.length,0);
 }
 for(const c of ['c99','p99','KEEP','NULL ']){
  const strict=validateChoices([target],{results:[{t:'t0',c}]},config);
  assert.equal(strict.accepted.length,0,String(c));
  assert.equal(strict.unresolved.length,1,String(c));
  const dropped=validateChoices([target],{results:[{t:'t0',c}]},{
    ...config,discardInvalidReviewResults:true,retryInvalidDictionaryChoices:false
  });
  assert.equal(dropped.unresolved.length,0,String(c));
  assert.equal(dropped.accepted[0].option.choice_id,null,String(c));
 }
});
