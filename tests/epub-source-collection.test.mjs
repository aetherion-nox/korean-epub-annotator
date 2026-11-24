import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {unzipSync,zipSync,strToU8,strFromU8} from '../epub-fflate.js';
import {openEpub,exportEpub,ingestPipelineResult,sentenceChunks} from '../epub-core.js';
import {runSentencePipeline} from '../annotation-pipeline.js';

const {window}=new JSDOM();
globalThis.DOMParser=window.DOMParser;
globalThis.XMLSerializer=window.XMLSerializer;
globalThis.NodeFilter=window.NodeFilter;

const root='OEBPS/';
const xhtml=body=>`<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ko">
 <head><title>테스트</title><link rel="stylesheet" href="book.css"/></head>
 <body>${body}</body></html>`;

function fixture(body,{extraManifest='',spine='<itemref idref="main"/>',extraFiles={}}={}){
 const files={
  mimetype:[strToU8('application/epub+zip'),{level:0}],
  'META-INF/container.xml':strToU8('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'+
   '<rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
  [root+'book.opf']:strToU8(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
   <manifest><item id="main" href="main.xhtml" media-type="application/xhtml+xml"/>
   <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
   <item id="css" href="book.css" media-type="text/css"/>${extraManifest}</manifest>
   <spine>${spine}</spine></package>`),
  [root+'main.xhtml']:strToU8(xhtml(body)),
  [root+'nav.xhtml']:strToU8(xhtml('<nav><p>목차</p></nav>')),
  [root+'book.css']:strToU8('.hidden { display: none; }'),
  ...Object.fromEntries(Object.entries(extraFiles).map(([name,content])=>[root+name,strToU8(content)]))
 };
 return {book:openEpub(zipSync(files)),files};
}

const identity={engine_version:'epub-source-test',dictionary_fingerprint:'fixture'};
const annotation=(text,surface,replacement,type='hanja')=>{
 const start=text.indexOf(surface);
 assert.ok(start>=0,`Missing ${surface} in ${text}`);
 return {start,end:start+surface.length,surface,replacement,type};
};

async function analyzeBook(book,expected,annotations=()=>[]){
 assert.deepEqual(book.sentences.map(s=>s.text),expected);
 const observed=[];
 const analyze=async text=>{
  observed.push(text);
  return {...identity,annotations:annotations(text),targets:[],stats:{}};
 };
 for(const [index,sentences] of sentenceChunks(book.sentences,{maxSentences:5}).entries()){
  await runSentencePipeline({operationId:`fixture-${index}`,sentences,
   restrictToSelection:true,modes:{hanja:true,loanword:true}},event=>ingestPipelineResult(book,event),{
   status:async()=>identity,analyze,analyzeBatch:texts=>Promise.all(texts.map(analyze))
  });
 }
 assert.deepEqual(observed,expected);
}

function parse(files,path){
 const doc=new DOMParser().parseFromString(strFromU8(files[path]),'application/xml');
 assert.equal(doc.getElementsByTagName('parsererror').length,0,path);
 return doc;
}

function assertArchivePreserved(output,original,...changed){
 assert.deepEqual(Object.keys(output).sort(),Object.keys(original).sort());
 for(const path of Object.keys(original)){
  if(path==='mimetype'||changed.includes(path))continue;
  assert.deepEqual(output[path],original[path],path);
 }
 assert.deepEqual(output.mimetype,original.mimetype[0]);
}

function assertOnlyRubyAdded(doc,original){
 for(const ruby of doc.querySelectorAll('ruby.kra-ruby')){
  ruby.replaceWith(doc.createTextNode(ruby.getAttribute('data-kra-original')));
 }
 doc.normalize();original.normalize();
 assert.ok(doc.isEqualNode(original),'XHTML differs after removing generated annotations');
}

test('spine analyzes non-linear XHTML once at its first reference and keeps OPF, links and filters',async()=>{
 const {book,files}=fixture('<p><a href="notes.xhtml#appendix">본문</a></p>',{
  extraManifest:'<item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/>'+
   '<item id="tail" href="tail.xhtml" media-type="application/xhtml+xml"/>'+
   '<item id="appendix" href="appendix.xhtml" media-type="application/xhtml+xml"/>'+
   '<item id="alias" href="./%6Eotes.xhtml" media-type="application/xhtml+xml"/>',
  spine:'<itemref idref="main"/><itemref idref="notes" linear="no"/><itemref idref="appendix" linear="no"/>'+
   '<itemref idref="tail"/><itemref idref="notes"/><itemref idref="alias"/>'+
   '<itemref idref="nav"/><itemref idref="css"/>',
  extraFiles:{'notes.xhtml':xhtml('<p id="appendix">주석</p>'),'tail.xhtml':xhtml('<p>결말</p>'),
   'appendix.xhtml':xhtml('<p>부록</p>')}
 });
 assert.deepEqual(book.chapters.map(c=>c.path),['main.xhtml','notes.xhtml','appendix.xhtml','tail.xhtml'].map(name=>root+name));
 const replacements={주석:'註釋',부록:'附錄'};
 await analyzeBook(book,['본문','주석','부록','결말'],text=>replacements[text]?[annotation(text,text,replacements[text])]:[]);
 const result=exportEpub(book),output=unzipSync(result.bytes);
 assert.equal(result.conversions,2);
 assertArchivePreserved(output,files,root+'notes.xhtml',root+'appendix.xhtml');
 const notes=parse(output,root+'notes.xhtml');
 const appendix=parse(output,root+'appendix.xhtml');
 assert.equal(notes.querySelector('#appendix > ruby > rt').textContent,'주석');
 assert.equal(appendix.querySelector('p > ruby > rt').textContent,'부록');
 assertOnlyRubyAdded(notes,parse(files,root+'notes.xhtml'));
 assertOnlyRubyAdded(appendix,parse(files,root+'appendix.xhtml'));
});

test('nested blocks and closed details produce ordered, disjoint source units even when CSS hides text',async()=>{
 const {book,files}=fixture('<div id="body">  경제 발전  <p>산업 정책을 연구합니다.</p>  사회 문제  '+
  '<details id="outer"><summary>자료 목록</summary>설명 내용'+
  '<details id="inner" open="open"><summary><em>추가 자료</em></summary><p>내부 문단</p></details>'+
  '참고 문헌</details>외부 본문'+
  '<section>연구 결과<article>조사 방법<div><p>분석 자료</p></div>이론 검토</article>최종 보고</section>'+
  '<p class="hidden" style="visibility: hidden">비공개 문서</p>종료 안내'+
  '<div></div>별도 항목</div>');
 const expected=['  경제 발전  ','산업 정책을 연구합니다.','  사회 문제  ','자료 목록','설명 내용',
  '추가 자료','내부 문단','참고 문헌','외부 본문','연구 결과','조사 방법','분석 자료','이론 검토',
  '최종 보고','비공개 문서','종료 안내','별도 항목'];
 assert.equal(book.chapters[0].entries.size,expected.length);
 assert.deepEqual(book.sentences.map(s=>s.selected),expected.map(text=>[{start:0,end:text.length}]));
 const replacements=['經濟','産業','社會','資料','說明','追加','內部','參考','外部','硏究','調査',
  '分析','理論','最終','非公開','終了','別途'];
 await analyzeBook(book,expected,text=>{
  const surface=text.trim().split(' ')[0];
  return [annotation(text,surface,replacements[expected.indexOf(text)])];
 });
 const result=exportEpub(book),output=unzipSync(result.bytes);
 assert.equal(result.conversions,expected.length);
 assertArchivePreserved(output,files,root+'main.xhtml');
 const doc=parse(output,root+'main.xhtml');
 assert.deepEqual([...doc.querySelectorAll('ruby > rt')].map(rt=>rt.textContent),
  expected.map(text=>text.trim().split(' ')[0]));
 assert.equal(doc.querySelector('#outer').hasAttribute('open'),false);
 assert.equal(doc.querySelector('#inner').getAttribute('open'),'open');
 assert.equal(doc.querySelector('#outer > summary > ruby > rt').textContent,'자료');
 assert.equal(doc.querySelector('#inner > summary > em > ruby > rt').textContent,'추가');
 assert.equal(doc.querySelector('.hidden > ruby > rt').textContent,'비공개');
 assertOnlyRubyAdded(doc,parse(files,root+'main.xhtml'));
});

test('inline source offsets and model results project back into their original elements',async()=>{
 const {book,files}=fixture('<p id="inline"><span>😀 </span><span>대</span><em>한</em><strong>민</strong>'+
  '<a href="#old">국</a>을 <span>게임</span></p>'+
  '<p>원문<ruby id="old">朝鮮<rt>조선</rt></ruby>보존</p>');
 const expected=['😀 대한민국을 게임','원문','보존'];
 const sentence=book.sentences[0];
 assert.deepEqual(sentence.selected,[{start:3,end:sentence.text.length}]);
 const hanja=annotation(sentence.text,'대한민국','大韓民國');
 const loanword=annotation(sentence.text,'게임','game','loanword');
 await analyzeBook(book,expected,text=>text===expected[0]?[hanja,loanword]:[]);
 const applyModel=annotations=>ingestPipelineResult(book,{type:'RESULTS',source:'model',
  results:[{id:sentence.id,annotations,reviewed:[hanja]}]});
 assert.equal(applyModel([]),6);
 const entries=[...book.chapters[0].entries.values()];
 assert.deepEqual(entries.flatMap(entry=>entry.annotations).map(a=>a.surface),['게임']);
 assert.deepEqual(entries.flatMap(entry=>entry.modelReviewed).map(r=>[r.start,r.end,r.surface]),
  [[0,1,'대'],[0,1,'한'],[0,1,'민'],[0,1,'국']]);
 assert.equal(applyModel([hanja]),6);
 const result=exportEpub(book),doc=parse(unzipSync(result.bytes),root+'main.xhtml');
 assert.equal(result.conversions,5);
 assert.deepEqual([...doc.querySelectorAll('#inline ruby')].map(r=>
  [r.parentElement.localName,r.firstChild.data,r.querySelector('rt').textContent]),[
  ['span','大','대'],['em','韓','한'],['strong','民','민'],['a','國','국'],['span','게임','game']
 ]);
 assert.equal(doc.querySelector('#inline a').getAttribute('href'),'#old');
 assert.equal(doc.querySelector('#old > rt').textContent,'조선');
 assertOnlyRubyAdded(doc,parse(files,root+'main.xhtml'));
});
