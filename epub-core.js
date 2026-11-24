// EPUB transport and DOM projection only. All linguistic decisions come from
// the v1.2.2 web annotator's existing runSentencePipeline implementation.
import {unzipSync,zipSync,strFromU8,strToU8} from './epub-fflate.js';
import {createParagraphPlan} from './paragraph-plan.js';
import {normalizeAnnotationAppearance} from './annotation-appearance.js';

const XHTML='http://www.w3.org/1999/xhtml';
const BLOCKS='p,li,dt,dd,td,th,h1,h2,h3,h4,h5,h6,blockquote,pre,figcaption';
const SKIP=new Set(['script','style','noscript','svg','math','rt','rp','nav']);
const HANGUL=/[가-힣]/u;
const utf8=new TextDecoder('utf-8',{fatal:true});

function safePath(path){
 if(!path||/^[\/\\]/.test(path)||path.includes('\\')||path.includes('\0'))throw Error('不安全的 EPUB 路径：'+path);
 const parts=[];
 for(const p of path.split('/')){
  if(!p||p==='.')continue;
  if(p==='..'){if(!parts.length)throw Error('EPUB 路径越界');parts.pop();}
  else parts.push(p);
 }
 return parts.join('/');
}
function resolvePath(base,href){
 let path;
 try{path=decodeURIComponent(String(href).split(/[?#]/)[0]);}
 catch{throw Error('EPUB 资源路径包含无效编码');}
 if(!path)throw Error('EPUB 资源路径为空');
 return safePath((base.includes('/')?base.slice(0,base.lastIndexOf('/')+1):'')+path);
}
function decode(bytes,path){try{return utf8.decode(bytes)}catch{throw Error('正文不是有效 UTF-8：'+path)}}
function parseXML(xml,label){
 const doc=new DOMParser().parseFromString(xml,'application/xml');
 if(doc.getElementsByTagName('parsererror').length||
    doc.getElementsByTagNameNS('*','parsererror').length)
  throw Error('EPUB XML 无法解析：'+label+'（可能有 DRM、损坏或非规范 XHTML）');
 return doc;
}
function descendants(element,name){return [...(element?.getElementsByTagNameNS('*',name)||[])];}
function first(element,name){return descendants(element,name)[0]||null;}
function children(element,name){return [...(element?.childNodes||[])].filter(n=>n.nodeType===1&&n.localName===name);}
function skipNode(node){
 for(let el=node.parentElement;el;el=el.parentElement){
  if(SKIP.has(el.localName?.toLowerCase())||el.localName?.toLowerCase()==='ruby')return true;
 }
 return false;
}
function readSource(element){
 if(!element)return {text:'',runs:[]};
 let text='';const runs=[];
 function visit(node){
  if(node.nodeType===3){
   runs.push({node,start:text.length,end:text.length+node.data.length});
   text+=node.data;return;
  }
  if(node.nodeType!==1||SKIP.has(node.localName?.toLowerCase())||
     node.localName?.toLowerCase()==='ruby')return;
  for(const child of node.childNodes)visit(child);
 }
 visit(element);return {text,runs};
}
function annotateNodes(doc){
 const body=first(doc,'body');if(!body)throw Error('XHTML 文件没有 body');
 const entries=new Map(),walker=doc.createTreeWalker(body,NodeFilter.SHOW_TEXT);
 for(let node=walker.nextNode();node;node=walker.nextNode()){
  if(!HANGUL.test(node.data)||skipNode(node))continue;
  const id=String(entries.size);
  entries.set(node,{node,id,text:node.data,selected:[{start:0,end:node.data.length}],
   annotations:[],localAnnotations:[],modelAnnotations:[],modelReviewed:[]});
 }
 return entries;
}
function pickSpine(files){
 const container=files['META-INF/container.xml'];
 if(!container)throw Error('EPUB 缺少 META-INF/container.xml');
 const root=parseXML(decode(container,'container.xml'),'container.xml');
 const opfPath=safePath(first(root,'rootfile')?.getAttribute('full-path')||'');
 const opf=files[opfPath];if(!opf)throw Error('EPUB 缺少书籍 OPF：'+opfPath);
 const packageDoc=parseXML(decode(opf,opfPath),opfPath);
 const manifest=first(packageDoc,'manifest'),spine=first(packageDoc,'spine');
 if(!manifest||!spine)throw Error('EPUB 缺少 manifest/spine');
 const items=new Map(children(manifest,'item').map(e=>[e.getAttribute('id'),e]));
 const filesOrdered=[];
 for(const itemref of children(spine,'itemref')){
  if(itemref.getAttribute('linear')==='no')continue;
  const entry=items.get(itemref.getAttribute('idref'));
  if(!entry)throw Error('EPUB spine 引用了不存在的条目');
  const type=entry.getAttribute('media-type');
  if(type!=='application/xhtml+xml'&&type!=='text/html')continue;
  if((entry.getAttribute('properties')||'').split(/\s+/u).includes('nav'))continue;
  const path=resolvePath(opfPath,entry.getAttribute('href'));
  if(!files[path])throw Error('EPUB 正文章节丢失：'+path);
  filesOrdered.push(path);
 }
 if(!filesOrdered.length)throw Error('EPUB 阅读顺序中没有可解析的 XHTML 正文');
 return filesOrdered;
}
function cleanFilename(filename){
 const raw=String(filename||'book.epub').replace(/\.epub$/iu,'');
 return raw.replace(/[<>:"/\\|?*\u0000-\u001f]/gu,'_').slice(0,180)+'-annotated.epub';
}
export function openEpub(buffer,filename='book.epub'){
 const data=new Uint8Array(buffer);
 if(data.byteLength>256*1024*1024)throw Error('EPUB 超过 256 MiB 安全限制');
 let unpacked;
 try{unpacked=unzipSync(data)}catch{throw Error('无法读取 EPUB ZIP，文件可能损坏、加密或不受支持')}
 const files=Object.create(null);let totalSize=0;
 for(const [name,bytes] of Object.entries(unpacked)){
  if(name.endsWith('/'))continue;
  const key=safePath(name);
  if(!key||files[key])throw Error('EPUB 文件路径不合法或重复：'+name);
  files[key]=bytes;totalSize+=bytes.length;
  if(totalSize>768*1024*1024)throw Error('EPUB 解压后超过 768 MiB 安全限制');
 }
 if(strFromU8(files.mimetype||new Uint8Array()).trim()!=='application/epub+zip')
  throw Error('文件不是有效 EPUB：mimetype 不正确');
 const paths=pickSpine(files),chapters=[],sentences=[],bySentence=new Map();
 let chapterIndex=0,totalChars=0;
 for(const path of paths){
  const doc=parseXML(decode(files[path],path),path),entries=annotateNodes(doc);
  const plan=createParagraphPlan(entries,readSource,BLOCKS,{preserveInlineHanja:true});
  const chapter={path,doc,entries,entryById:new Map([...entries.values()].map(e=>[e.id,e])),plan,index:chapterIndex++};
  chapters.push(chapter);
  for(const sentence of plan.sentences){
   if(!HANGUL.test(sentence.text))continue;
   const id='ep'+chapter.index+'_'+sentence.id;
   const current={...sentence,id};
   bySentence.set(id,{chapter,localId:sentence.id});
   sentences.push(current);totalChars+=sentence.text.length;
  }
 }
 return {filename:cleanFilename(filename),files,chapters,sentences,bySentence,
  stats:{chapters:chapters.length,paragraphs:sentences.length,characters:totalChars,conversions:0}};
}
export function ingestPipelineResult(book,event){
 if(event?.type!=='RESULTS'||event.provisional===true)return 0;
 let updates=0;
 for(const result of event.results||[]){
  const key=book.bySentence.get(result.id);if(!key)continue;
  const {chapter,localId}=key;
  for(const item of chapter.plan.projectResult({...result,id:localId},{
   source:event.source,provisional:false
  })){
   const entry=chapter.entryById.get(item.id);
   if(!entry)continue;
   if(event.source==='model'){
    // A model-approved KEEP/null/nonconversion decision has *no* replacement
    // annotation but still supersedes any local annotation on that range.
    // The model's reviewed spans, not only the produced ruby spans, are
    // authoritative. An empty reviewed list is not a rejection of local work.
    entry.modelAnnotations=item.annotations||[];
    entry.modelReviewed=(item.reviewed||[]).filter(r=>
     Number.isInteger(r.start)&&Number.isInteger(r.end)&&r.start>=0&&
     r.end>r.start&&r.end<=entry.text.length&&
     entry.text.slice(r.start,r.end)===r.surface);
   }else entry.localAnnotations=item.annotations||[];
   const model=entry.modelAnnotations||[];
   const reviewed=entry.modelReviewed||[];
   entry.annotations=[...(entry.localAnnotations||[]).filter(a=>
    !reviewed.some(r=>a.start<r.end&&a.end>r.start)&&
    !model.some(b=>a.start<b.end&&a.end>b.start)),...model];
   updates++;
  }
 }
 return updates;
}
function rubyNode(doc,a,appearance){
 const ruby=doc.createElementNS(XHTML,'ruby');
 ruby.setAttribute('class','kra-ruby');
 ruby.setAttribute('data-kra-type',a.type);
 ruby.setAttribute('data-kra-original',a.surface);
 ruby.setAttribute('style','ruby-position: over');
 const base=a.type==='hanja'?a.replacement:a.surface;
 const reading=a.type==='hanja'?a.surface:a.replacement.replace(/[←→]/gu,'');
 if(!reading)return null;
 ruby.appendChild(doc.createTextNode(base));
 const rt=doc.createElementNS(XHTML,'rt');
 rt.setAttribute('style',`font-size: ${appearance.size}%; color: inherit; opacity: ${appearance.opacity/100}`);
 rt.appendChild(doc.createTextNode(reading));
 ruby.appendChild(rt);return ruby;
}
function paintEntry(entry,appearance){
 const node=entry.node;
 if(!node.parentNode||node.data!==entry.text)return 0;
 const valid=[...entry.annotations].sort((a,b)=>a.start-b.start);
 let cursor=0,count=0;
 const fragment=node.ownerDocument.createDocumentFragment();
 for(const a of valid){
  if(!['hanja','loanword'].includes(a.type)||!Number.isInteger(a.start)||
     !Number.isInteger(a.end)||a.start<cursor||a.end<=a.start||a.end>entry.text.length||
     entry.text.slice(a.start,a.end)!==a.surface||!a.replacement)continue;
  const ruby=rubyNode(node.ownerDocument,a,appearance);if(!ruby)continue;
  if(a.start>cursor)fragment.appendChild(node.ownerDocument.createTextNode(entry.text.slice(cursor,a.start)));
  fragment.appendChild(ruby);cursor=a.end;count++;
 }
 if(!count)return 0;
 if(cursor<entry.text.length)fragment.appendChild(node.ownerDocument.createTextNode(entry.text.slice(cursor)));
 node.parentNode.replaceChild(fragment,node);return count;
}
export function exportEpub(book,settings){
 const appearance=normalizeAnnotationAppearance(settings);
 let conversions=0;
 for(const chapter of book.chapters){
  let changes=0;
  for(const entry of chapter.entries.values())changes+=paintEntry(entry,appearance);
  if(changes){
   book.files[chapter.path]=strToU8(new XMLSerializer().serializeToString(chapter.doc));
   conversions+=changes;
  }
 }
 book.stats.conversions=conversions;
 const archive={mimetype:[strToU8('application/epub+zip'),{level:0}]};
 for(const [path,bytes] of Object.entries(book.files))
  if(path!=='mimetype')archive[path]=[bytes,{level:6}];
 const packed=zipSync(archive,{level:6});
 return {bytes:packed,filename:book.filename,conversions};
}
export function sentenceChunks(sentences,{maxSentences=75,maxCharacters=60000}={}){
 const chunks=[];let chunk=[],characters=0;
 for(const sentence of sentences){
  if(chunk.length&&(chunk.length>=maxSentences||characters+sentence.text.length>maxCharacters)){
   chunks.push(chunk);chunk=[];characters=0;
  }
  chunk.push(sentence);characters+=sentence.text.length;
 }
 if(chunk.length)chunks.push(chunk);
 return chunks;
}
