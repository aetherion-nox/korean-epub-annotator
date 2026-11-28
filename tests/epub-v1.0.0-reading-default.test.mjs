import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runSentencePipeline} from '../annotation-pipeline.js';
import {ENGINE_SWITCH_DEFAULTS,engineSwitchValues} from '../engine-defaults.js';

const identity={engine_version:'epub-1.0.0-default-test',dictionary_fingerprint:'fixture',
 dictionary_metadata:{}};
const passage='경제 정책';
const analyze=async()=>({...identity,annotations:[],targets:[{
 target_id:'original0',context:passage,start:0,end:2,surface:'경제',
 options:[
  {choice_id:null,type:'keep',replacement:'경제',entry_id:null,definitions:[]},
  {choice_id:'c0',type:'hanja',replacement:'經濟',entry_id:500,
   definitions:['economy']}
 ]
}],stats:{pending:1,local_determined:0}});

test('EPUB default switch stays off on new and old settings',()=>{
 assert.equal(ENGINE_SWITCH_DEFAULTS.hanjaReadingCheck,false);
 assert.equal(engineSwitchValues({}).hanjaReadingCheck,false);
 assert.equal(engineSwitchValues({experimentalHanja:true}).hanjaReadingCheck,false);
 assert.equal(engineSwitchValues({experimentalHanja:true,hanjaReadingCheck:false}).hanjaReadingCheck,false);
 assert.equal(engineSwitchValues({experimentalHanja:true,hanjaReadingCheck:true}).hanjaReadingCheck,true);
});

for(const [label,provided,expected] of [
 ['undefined/omitted',undefined,false],
 ['explicit false',false,false],
 ['explicit true',true,true]
]){
 test('EPUB 1.0.0 pipeline reading check: '+label,async()=>{
  let called=0,passed;
  const flags=provided===undefined?{}:{hanjaReadingCheck:provided};
  const config={provider:'custom',model:'fixture',endpoint:'fixture://test',batchContextTier:'32k',
   reviewPosFilter:false,experimentalHanja:true,retryInvalidDictionaryChoices:true,
   discardInvalidReviewResults:false,...flags,
   request:async(requestConfig,wire)=>{
    called++;passed=requestConfig.hanjaReadingCheck;
    assert.equal(passed,expected,'request must use the exact strict-boolean setting');
    return {results:wire.map(t=>({t:t.target_id,c:null}))};
   }};
  const events=[];
  const stats=await runSentencePipeline({
   operationId:'epub-reading-'+label.replace(/[^a-z]+/g,'-'),
   epubBookSession:true,epubBookRunId:'book-reading-check',
   sentences:[{id:'chapter0_s0',text:passage}],context:passage,
   modes:{hanja:true,loanword:false},smartSegmentation:false,
   reviewLocalConversions:true
  },e=>events.push(e),{
   analyze,status:async()=>identity,enabled:true,modelConfig:async()=>config,
   cache:new Map(),persist:async()=>{}
  });
  assert.equal(called,1);
  assert.equal(passed,expected);
  assert.equal(stats.model_unanswered,0);
  assert.ok(events.some(e=>e.type==='DONE'));
 });
}

test('EPUB cache fingerprint and review config use the same strict true test as Web',()=>{
 const source=readFileSync(new URL('../annotation-pipeline.js',import.meta.url),'utf8');
 assert.match(source,/hanjaReadingCheck:config\.hanjaReadingCheck===true/);
 assert.match(source,/fingerprint=config&&JSON\.stringify\(\[\s*config\.hanjaReadingCheck===true,/);
 assert.doesNotMatch(source,/config\.hanjaReadingCheck!==false/);
});

test('preview versions use Chrome manifest and semver package formats',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../manifest.json',import.meta.url)));
 const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));
 assert.equal(manifest.version,'1.0.15');
 assert.equal(pkg.version,'1.0.15');
 assert.equal(manifest.content_scripts,undefined);
});
