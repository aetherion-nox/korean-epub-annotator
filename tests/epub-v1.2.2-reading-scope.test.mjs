import test from 'node:test';
import assert from 'node:assert/strict';
import {validateChoices,validateExperimentalChoices} from '../choice-review.js';
import {literalOriginOption} from '../experimental-options.js';
import {epubSafeCorrectionTarget,epubInvalidChoiceReason} from '../epub-choice-correction.js';
import {ENGINE_SWITCH_DEFAULTS,engineSwitchValues} from '../engine-defaults.js';

const keep=surface=>({choice_id:null,type:'keep',replacement:surface,entry_id:null,definitions:[]});
function target(context,surface,replacement){
 const start=context.indexOf(surface);
 return {target_id:'t0',start,end:start+surface.length,surface,context,
  options:[keep(surface),{choice_id:'c0',type:'hanja',replacement,entry_id:53,definitions:['dictionary candidate']}]};
}

test('EPUB numbered-year 年 dictionary options survive reading check on or off',()=>{
 for(const context of ['2026년','3년','1993년','167년']){
  const t=target(context,'년','年');
  for(const enabled of [false,true]){
   const config={epubBookSession:true,hanjaReadingCheck:enabled,experimentalHanja:true,reviewPosFilter:false};
   assert.equal(epubSafeCorrectionTarget(t,config).options.length,2);
   for(const validator of [validateChoices,validateExperimentalChoices]){
    const verdict=validator([t],{results:[{t:'t0',c:'c0'}]},config);
    assert.equal(verdict.accepted.length,1,context);
    assert.equal(verdict.accepted[0].option.replacement,'年',context);
    assert.equal(verdict.unresolved.length,0,context);
   }
  }
 }
});

test('EPUB correction keeps target-valid dictionary options but not imaginary IDs',()=>{
 const t=target('사과','사과','韓國');
 const config={epubBookSession:true,hanjaReadingCheck:true,experimentalHanja:true,reviewPosFilter:false};
 assert.equal(epubSafeCorrectionTarget(t,config).options.find(o=>o.choice_id==='c0')?.replacement,'韓國');
 assert.equal(validateChoices([t],{results:[{t:'t0',c:'c0'}]},config).accepted.length,1);
 const bad=validateChoices([t],{results:[{t:'t0',c:'c99'}]},config);
 assert.deepEqual(bad.invalidDictionaryChoiceIds,['t0']);
 assert.equal(bad.unresolved.length,1);
 assert.equal(epubInvalidChoiceReason(t,'c99',config),'choice_not_in_target_options');
});

test('experimental raw Hanja is checked only when the user opted in',()=>{
 const t={...target('사과','사과','韓國'),options:[keep('사과')]};
 assert.equal(ENGINE_SWITCH_DEFAULTS.hanjaReadingCheck,false);
 assert.equal(engineSwitchValues({experimentalHanja:false,hanjaReadingCheck:true}).hanjaReadingCheck,false);
 assert.equal(literalOriginOption(t,'韓國',{experimentalHanja:true})?.origin_source,'model-unverified');
 assert.equal(literalOriginOption(t,'韓國',{experimentalHanja:true,hanjaReadingCheck:false})?.origin_source,'model-unverified');
 assert.equal(literalOriginOption(t,'韓國',{experimentalHanja:true,hanjaReadingCheck:true}),null);
});
