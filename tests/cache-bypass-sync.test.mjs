import test from 'node:test';
import assert from 'node:assert/strict';
import {readCacheBypass} from '../cache-bypass-settings.js';
import {canProposeExperimentalOption} from '../experimental-options.js';
import {modelTargets} from '../choice-review.js';
import {readFileSync} from 'node:fs';
test('temporary clears on restart, persistent survives',async()=>{
 const session={},local={},storage={session:{get:async k=>({[k]:session[k]})},local:{get:async k=>({[k]:local[k]})}};
 assert.deepEqual(await readCacheBypass(storage),{temporary:false,persistent:false});
 session.sessionForceRegenerate=true;
 assert.equal((await readCacheBypass(storage)).temporary,true);
 local.persistentForceRegenerate=true;delete session.sessionForceRegenerate;
 assert.deepEqual(await readCacheBypass(storage),{temporary:false,persistent:true});
});
test('name flags are hints, explicit protected boundary still vetoes',()=>{
 const t={target_id:'t',surface:'시진핑',start:0,end:3,context:'시진핑',dictionary_person_name:true,options:[{type:'keep',choice_id:null,replacement:'시진핑',entry_id:null,definitions:[]}]};
 assert.equal(canProposeExperimentalOption(t,'hanja'),true);
 const [wire]=modelTargets([{...t,protected_name_boundary:true}],{experimentalHanja:true});
 assert.equal(wire.protected_name_boundary,true);
 assert.equal(canProposeExperimentalOption(wire,'hanja'),false);
});
test('whole book captures bypass before planning and sends it with each group',()=>{
 const src=readFileSync(new URL('../epub-app.js',import.meta.url),'utf8');
 assert.match(src,/forceRegenerateForBook=await cacheBypass\.snapshot\(\)/);
 assert.match(src,/forceRegenerate:forceRegenerateForBook/);
});
