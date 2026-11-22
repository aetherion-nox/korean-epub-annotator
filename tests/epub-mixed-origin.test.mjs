import test from 'node:test';
import assert from 'node:assert/strict';
import {alignMixedLiteralOrigin} from '../mixed-origin-alignment.js';
import {literalOriginOption,explainLiteralOriginRejection} from '../experimental-options.js';
import {validateExperimentalChoices} from '../choice-review.js';
import {projectAnnotation} from '../local-engine.js';

const enabled={experimentalHanja:true,experimentalLoanword:true,hanjaReadingCheck:false};
const target=(surface,context=surface,start=0)=>({
 target_id:'t0',start,end:start+surface.length,surface,context,
 options:[{choice_id:null,type:'keep',replacement:surface,definitions:[],entry_id:null}]
});
const projection=(t,choice,config=enabled)=>{
 const option=literalOriginOption(t,choice,config);
 assert.ok(option,'expected accepted option for '+choice);
 return {option,spans:projectAnnotation(t.context,{...t,...option})};
};

test('Latin + unchanged Korean anywhere: suffix, prefix and middle',()=>{
 const a=projection(target('터부도'),'taboo도');
 assert.equal(a.option.type,'loanword');
 assert.deepEqual(a.spans.map(x=>[x.start,x.end,x.surface,x.replacement,x.type]),
  [[0,2,'터부','taboo','loanword']]);
 const b=projection(target('우리컴퓨터는'),'우리computer는');
 assert.deepEqual(b.spans.map(x=>[x.surface,x.replacement]),[['컴퓨터','computer']]);
 const c=projection(target('와터부'),'와taboo');
 assert.deepEqual(c.spans.map(x=>[x.surface,x.replacement]),[['터부','taboo']]);
});
test('genuine Hanja mixed spelling retains Hangul anchors without suffix POS requirement',()=>{
 const a=projection(target('금기도'),'禁忌도');
 assert.equal(a.option.type,'hanja');
 assert.deepEqual(a.spans.map(x=>[x.surface,x.replacement]),[['금기','禁忌']]);
 const b=projection(target('재확인도'),'재確認도');
 assert.deepEqual(b.spans.map(x=>[x.surface,x.replacement]),[['확인','確認']]);
 const c=projection(target('금기도'),'禁忌도',{experimentalHanja:true,hanjaReadingCheck:true});
 assert.equal(c.spans.length,1);
});
test('Latin variants work; underscore, arbitrary Korean edits and disabled modes are rejected',()=>{
 assert.equal(projection(target('카페도'),'café도').spans[0].replacement,'café');
 assert.equal(projection(target('카페도'),'cafe\u0301도').spans[0].replacement,'cafe\u0301');
 assert.equal(literalOriginOption(target('터부도'),'_taboo도',enabled),null);
 assert.equal(literalOriginOption(target('터부도'),'taboo가',enabled),null);
 assert.equal(literalOriginOption(target('터부도'),'taboo도',{experimentalHanja:true}),null);
 assert.equal(literalOriginOption(target('금기도'),'禁忌도',{experimentalLoanword:true}),null);
});
test('ambiguous positions and Hanja count mismatch never choose arbitrary origin spans',()=>{
 assert.equal(alignMixedLiteralOrigin('아나나나','X나Y',enabled),null);
 assert.equal(literalOriginOption(target('아나나나'),'X나Y',enabled),null);
 assert.equal(literalOriginOption(target('금기도'),'禁止도',enabled)===null,false,
  'same-length but semantically wrong characters are not reliably detectable with reading audit disabled');
 assert.equal(literalOriginOption(target('금기도'),'禁止도',
  {experimentalHanja:true,hanjaReadingCheck:true}),null,
  'enabled reading audit must reject a genuine pronunciation mismatch');
 assert.equal(literalOriginOption(target('금기도'),'禁忌기도',enabled),null,
  'a repeated unchanged Korean run must not consume extra source text');
});
test('one response can directly accept mixed literal without a second segmentation repair',()=>{
 const t=target('터부도');
 const result=validateExperimentalChoices([t],{results:[{t:'t0',c:'taboo도'}]},
  {experimentalLoanword:true});
 assert.equal(result.unresolved.length,0);
 assert.equal(result.accepted.length,1);
 assert.equal(result.accepted[0].option.segments[0].surface,'터부');
 assert.equal(explainLiteralOriginRejection(t,'taboo가',enabled),'embedded_hangul_alignment_or_boundary');
});
