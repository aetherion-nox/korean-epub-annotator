import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {unzipSync,zipSync,strToU8,strFromU8} from '../epub-fflate.js';
import {openEpub,exportEpub,ingestPipelineResult,sentenceChunks} from '../epub-core.js';
import {extractInlineHanjaPairs} from '../inline-hanja-evidence.js';

const {JSDOM}=createRequire(import.meta.url)('jsdom');
const dom=new JSDOM('<!doctype html><html><body></body></html>');
globalThis.DOMParser=dom.window.DOMParser;
globalThis.XMLSerializer=dom.window.XMLSerializer;
globalThis.NodeFilter=dom.window.NodeFilter;
const container='<?xml version="1.0" encoding="UTF-8"?>'+
 '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">'+
 '<rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const opf='<?xml version="1.0" encoding="UTF-8"?>'+
 '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'+
 '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">test-book</dc:identifier><dc:title>EPUB Test</dc:title></metadata>'+
 '<manifest><item id="one" href="Text/a.xhtml" media-type="application/xhtml+xml"/>'+
 '<item id="two" href="Text/b.xhtml" media-type="application/xhtml+xml"/>'+
 '<item id="css" href="Styles/book.css" media-type="text/css"/>'+
 '<item id="nav" href="Text/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest>'+
 '<spine><itemref idref="one"/><itemref idref="two"/></spine></package>';
const html=(body)=>'<?xml version="1.0" encoding="UTF-8"?>'+
 '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ko"><head>'+
 '<title>Test</title><link rel="stylesheet" href="../Styles/book.css"/></head><body>'+
 body+'</body></html>';
const original={
 mimetype:strToU8('application/epub+zip'),
 'META-INF/container.xml':strToU8(container),
 'OEBPS/book.opf':strToU8(opf),
 'OEBPS/Text/a.xhtml':strToU8(html('<h2>첫 장</h2><p>오늘 <em>학교</em>에 가요.</p><p>경<span>제</span> 성장</p>')),
 'OEBPS/Text/b.xhtml':strToU8(html('<p>원잠과 게임을 좋아해요.</p>')),
 'OEBPS/Text/nav.xhtml':strToU8(html('<nav><p>목차</p></nav>')),
 'OEBPS/Styles/book.css':strToU8('p { color: #123456; }'),
 'OEBPS/Pictures/cover.png':new Uint8Array([137,80,78,71,13,10,26,10,1,2,3])
};
function fixture(overrides={}){
 const entries={mimetype:[overrides.mimetype||original.mimetype,{level:0}]};
 for(const [path,content] of Object.entries({...original,...overrides})){
  if(path==='mimetype'||content===null)continue;
  entries[path]=[content,{level:6}];
 }
 return zipSync(entries);
}
function add(book,query,source,replacement,type='hanja'){
 const sentence=book.sentences.find(s=>s.text.includes(query));
 assert.ok(sentence,'Expected sentence '+query);
 const start=sentence.text.indexOf(source);
 assert.ok(start>=0);
 // The web engine's replaceModel stream carries a cumulative paragraph
 // snapshot, not a separate isolated patch for each answer in that paragraph.
 const accepted=book.__testModelAccepted||(book.__testModelAccepted=new Map());
 const annotations=[...(accepted.get(sentence.id)||[]),{start,end:start+source.length,
  surface:source,replacement,type}];
 accepted.set(sentence.id,annotations);
 const result={id:sentence.id,annotations,
  reviewed:annotations.map(a=>({start:a.start,end:a.end,surface:a.surface}))};
 assert.ok(ingestPipelineResult(book,{type:'RESULTS',source:'model',
  results:[result],provisional:false})>0);
}
test('EPUB spine extracts only original Korean chapter paragraphs',()=>{
 const book=openEpub(fixture(),'봄봄.epub');
 assert.equal(book.filename,'봄봄-annotated.epub');
 assert.equal(book.stats.chapters,2);
 assert.ok(book.sentences.some(s=>s.text==='오늘 학교에 가요.'));
 assert.ok(book.sentences.some(s=>s.text.includes('원잠과 게임을')));
 assert.ok(!book.sentences.some(s=>s.text==='목차'));
 const chunks=sentenceChunks(book.sentences,{maxSentences:1});
 assert.equal(chunks.length,book.sentences.length);
 assert.ok(chunks.every(x=>x.length===1));
});
test('Hanja/loanword annotations preserve inline XHTML tags, media, OPF and CSS',()=>{
 const book=openEpub(fixture(),'봄봄.epub');
 add(book,'학교','학교','學校');
 add(book,'원잠','원잠','原潛');
 add(book,'게임','게임','game','loanword');
 add(book,'경제','경','經');
 const result=exportEpub(book);
 assert.equal(result.filename,'봄봄-annotated.epub');
 assert.equal(result.conversions,4);
 const exported=unzipSync(result.bytes);
 const a=strFromU8(exported['OEBPS/Text/a.xhtml']);
 const b=strFromU8(exported['OEBPS/Text/b.xhtml']);
 assert.match(a,/<em><ruby/);
 assert.match(a,/學校<rt[^>]*>학교<\/rt>/);
 assert.match(a,/經<rt[^>]*>경<\/rt>/);
 assert.match(b,/原潛<rt[^>]*>원잠<\/rt>/);
 assert.match(b,/게임<rt[^>]*>game<\/rt>/);
 assert.deepEqual(exported['OEBPS/Pictures/cover.png'],original['OEBPS/Pictures/cover.png']);
 assert.deepEqual(exported['OEBPS/book.opf'],original['OEBPS/book.opf']);
 assert.deepEqual(exported['OEBPS/Styles/book.css'],original['OEBPS/Styles/book.css']);
 assert.deepEqual(exported['OEBPS/Text/nav.xhtml'],original['OEBPS/Text/nav.xhtml']);
 assert.ok(!Object.keys(exported).some(s=>s.endsWith('.zip')));
 const dv=new DataView(result.bytes.buffer,result.bytes.byteOffset,result.bytes.byteLength);
 assert.equal(dv.getUint32(0,true),0x04034b50);
 assert.equal(dv.getUint16(8,true),0,'EPUB mimetype must use STORE, not DEFLATE');
 const filenameLen=dv.getUint16(26,true);
 assert.equal(strFromU8(result.bytes.slice(30,30+filenameLen)),'mimetype');
 assert.equal(strFromU8(exported.mimetype),'application/epub+zip');
});
test('model KEEP/null suppresses an earlier local conversion through reviewed spans',()=>{
 const book=openEpub(fixture());
 const sentence=book.sentences.find(s=>s.text.includes('학교'));
 const start=sentence.text.indexOf('학교');
 const local={start,end:start+2,surface:'학교',replacement:'學校',type:'hanja'};
 assert.ok(ingestPipelineResult(book,{type:'RESULTS',source:'local',
  results:[{id:sentence.id,annotations:[local]}]})>0);
 // User-approved model null: no conversion fragment, but a reviewed range.
 assert.ok(ingestPipelineResult(book,{type:'RESULTS',source:'model',replaceModel:true,
  results:[{id:sentence.id,annotations:[],
   reviewed:[{start,end:start+2,surface:'학교'}]}]})>0);
 const out=exportEpub(book);
 assert.equal(out.conversions,0);
 assert.deepEqual(unzipSync(out.bytes)['OEBPS/Text/a.xhtml'],original['OEBPS/Text/a.xhtml']);
});
test('model rejects only the reviewed span; unrelated local annotations remain',()=>{
 const book=openEpub(fixture());
 const sentence=book.sentences.find(s=>s.text.includes('원잠과 게임'));
 const a=sentence.text.indexOf('원잠'),b=sentence.text.indexOf('게임');
 const local=[
  {start:a,end:a+2,surface:'원잠',replacement:'原潛',type:'hanja'},
  {start:b,end:b+2,surface:'게임',replacement:'game',type:'loanword'}
 ];
 ingestPipelineResult(book,{type:'RESULTS',source:'local',results:[{id:sentence.id,annotations:local}]});
 ingestPipelineResult(book,{type:'RESULTS',source:'model',replaceModel:true,
  results:[{id:sentence.id,annotations:[],reviewed:[{start:a,end:a+2,surface:'원잠'}]}]});
 const out=exportEpub(book);
 const html=strFromU8(unzipSync(out.bytes)['OEBPS/Text/b.xhtml']);
 assert.equal(out.conversions,1);
 assert.match(html,/원잠과/);
 assert.match(html,/게임<rt[^>]*>game<\/rt>/);
 assert.doesNotMatch(html,/原潛/);
});
test('model with an empty reviewed scope does not erase local-only markup',()=>{
 const book=openEpub(fixture());
 const sentence=book.sentences.find(s=>s.text.includes('원잠과 게임'));
 const start=sentence.text.indexOf('원잠');
 ingestPipelineResult(book,{type:'RESULTS',source:'local',
  results:[{id:sentence.id,annotations:[{start,end:start+2,surface:'원잠',replacement:'原潛',type:'hanja'}]}]});
 ingestPipelineResult(book,{type:'RESULTS',source:'model',replaceModel:true,
  results:[{id:sentence.id,annotations:[],reviewed:[]}]});
 assert.equal(exportEpub(book).conversions,1);
});
test('provisional SSE previews are never committed to final book',()=>{
 const book=openEpub(fixture());
 const s=book.sentences.find(s=>s.text.includes('학교'));
 ingestPipelineResult(book,{type:'RESULTS',source:'model',provisional:true,
  results:[{id:s.id,annotations:[{start:3,end:5,surface:'학교',replacement:'學校',type:'hanja'}]}]});
 const result=exportEpub(book);
 assert.equal(result.conversions,0);
 assert.deepEqual(unzipSync(result.bytes)['OEBPS/Text/a.xhtml'],original['OEBPS/Text/a.xhtml']);
});
test('missing EPUB mime, invalid spine and corrupt ZIP fail without generating a fake EPUB ZIP',()=>{
 assert.throws(()=>openEpub(new Uint8Array([0,1,2,3])),/ZIP/);
 assert.throws(()=>openEpub(fixture({mimetype:strToU8('application/zip')})),/mimetype/);
 assert.throws(()=>openEpub(fixture({'OEBPS/book.opf':strToU8('<corrupt>')})),/XML/);
});
test('Chrome entrypoint is self-contained and does not inject website content scripts',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../manifest.json',import.meta.url),'utf8'));
 assert.equal(manifest.version,'1.0.7');
 assert.equal(manifest.action.default_popup,undefined);
 assert.equal(manifest.content_scripts,undefined);
 const app=readFileSync(new URL('../epub-app.js',import.meta.url),'utf8');
 assert.match(app,/KRA_SENTENCE_STREAM_V1/);
 assert.match(app,/MANUAL_REVIEW_REQUEST/);
 assert.match(app,/MANUAL_REVIEW_RESPONSE/);
 assert.match(app,/downloadBook\(\)/);
 const worker=readFileSync(new URL('../service-worker.js',import.meta.url),'utf8');
 assert.match(worker,/chrome\.action\.onClicked/);
});

test('EPUB joins author Hangul(漢字) pairs across inline XHTML tags, preserving original offsets',()=>{
 const source='<p>아까 <span>백</span><em>영</em>관(白靈觀)을 만났다.</p>';
 const book=openEpub(fixture({'OEBPS/Text/a.xhtml':strToU8(html(source))}));
 const sentence=book.sentences.find(r=>r.text.includes('백영관(白靈觀)'));
 assert.ok(sentence,'inline DOM text nodes must be joined before the local engine');
 const pairs=extractInlineHanjaPairs(sentence.text);
 assert.equal(pairs.length,1);
 assert.equal(pairs[0].surface,'백영관');
 assert.equal(pairs[0].hanja,'白靈觀');
 assert.equal(sentence.text.slice(pairs[0].start,pairs[0].end),'백영관');
});
test('EPUB 20K splits never divide the Hangul and the parentheses that establish an author source',()=>{
 // The last horizontal space is precisely between Hangul and the parenthesis.
 const paragraph='a'.repeat(19994)+' 백영관 (白靈觀)'+ '나'.repeat(200);
 const book=openEpub(fixture({'OEBPS/Text/a.xhtml':strToU8(html('<p>'+paragraph+'</p>'))}));
 const parts=book.sentences.filter(r=>r.text.includes('백영관')||r.text.includes('白靈觀'));
 assert.equal(parts.length,1,'the complete source pair must remain within a single analysis paragraph');
 assert.match(parts[0].text,/백영관 \(白靈觀\)/u);
 assert.equal(extractInlineHanjaPairs(parts[0].text).length,1);
 assert.ok(book.sentences.every(r=>r.text.length<=20000));
});

test('EPUB exports configured ruby size and opacity without changing original styles',()=>{
 const book=openEpub(fixture());add(book,'학교','학교','學校');
 const out=unzipSync(exportEpub(book,{size:65,opacity:40}).bytes);
 assert.match(strFromU8(out['OEBPS/Text/a.xhtml']),/font-size: 65%; color: inherit; opacity: 0\.4/);
 assert.deepEqual(out['OEBPS/Styles/book.css'],original['OEBPS/Styles/book.css']);
});
