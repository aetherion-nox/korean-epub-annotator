import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateAnalysis} from '../local-engine.js';
import {buildReviewPayload} from '../review-payload.js';
const source=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('one global streaming switch and file-task snapshot',()=>{
 assert.ok(!source('options.html').includes('newProviderStream'));
 assert.ok(!source('options.js').includes('newProviderStream'));
 assert.ok(!source('api-profiles.js').includes('providerStream'));
 assert.match(source('service-worker.js'),/stream: localState\.progressiveAnnotation===true/);
 assert.equal([...source('annotation-pipeline.js').matchAll(/stream:progressive,/g)].length,2);
 assert.ok(source('epub-app.js').includes('progressiveAnnotation:progressive'));
});
test('spaced phrase candidates pass validation and remain model evidence',()=>{
 const text='일산화 탄소',phrase_origin='일산화 탄소 (一酸化炭素)';
 const targets=[[0,3,'일산화','一酸化'],[4,6,'탄소','炭素']].map(([start,end,surface,replacement],i)=>({target_id:'t'+i,start,end,surface,context:text,options:[{choice_id:null,type:'keep',replacement:surface,entry_id:null,definitions:[]},{choice_id:'c0',type:'hanja',replacement,entry_id:254095,definitions:['Complete dictionary phrase: '+phrase_origin],written_form:'일산화^탄소',phrase_origin}]}));
 const data={engine_version:'fixture',dictionary_fingerprint:'fixture',annotations:[],targets,stats:{}};
 const valid=validateAnalysis(text,data);
 assert.equal(valid.targets.length,2);
 assert.equal(valid.targets[0].options[1].phrase_origin,phrase_origin);
 assert.ok(JSON.stringify(buildReviewPayload(text,valid.targets,{reviewPosFilter:false})).includes(phrase_origin));
 assert.throws(()=>validateAnalysis(text,{...data,targets:[{...targets[0],options:[targets[0].options[0],{...targets[0].options[1],phrase_origin:42}]}]}),/Invalid phrase origin metadata/);
});

test('derived foreign and mixed phrase options pass the file engine validator',()=>{
 for(const [surface,type,replacement,segments] of [
  ['인터넷','loanword','internet',undefined],
  ['게임기','mixed','game機',[{start:0,end:2,surface:'게임',type:'loanword',replacement:'game'},{start:2,end:3,surface:'기',type:'hanja',replacement:'機'}]]
 ]){
  const phrase_origin=surface+' 장치 ('+replacement+'裝置)';
  const option={choice_id:'c0',type,replacement,entry_id:1,definitions:['Complete dictionary phrase: '+phrase_origin],phrase_origin,...(segments?{segments}:{})};
  const data={engine_version:'fixture',dictionary_fingerprint:'fixture',annotations:[],stats:{},targets:[{target_id:'t0',start:0,end:surface.length,surface,context:surface,options:[{choice_id:null,type:'keep',replacement:surface,entry_id:null,definitions:[]},option]}]};
  const valid=validateAnalysis(surface,data);
  assert.equal(valid.targets[0].options[1].replacement,replacement);
  assert.ok(JSON.stringify(buildReviewPayload(surface,valid.targets,{reviewPosFilter:false})).includes(phrase_origin));
 }
});
