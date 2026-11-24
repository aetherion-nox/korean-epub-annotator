import {openEpub,ingestPipelineResult,exportEpub,sentenceChunks} from './epub-core.js';
import {manualRequestIdentity,sameManualTargets,transferManualAnswer} from './epub-recovery.js';

const el=id=>document.getElementById(id);
const tabs=[['annotateTab','annotatePanel'],['settingsTab','settingsPanel']];
let busy=false,download=null,currentPort=null,operationId=null,manualRequest=null;
let totalChunks=0,doneChunks=0;
let plannedByChunk=[],totalPlannedReviewRequests=0;
let effectiveApiConcurrency=1,apiReviewActive=false;
let completedInitialRequests=new Set(),runningInitialRequests=new Set();
const livePorts=new Map();
const saneConcurrency=(value,limit=10000)=>{
 const n=Number(value);
 return Number.isSafeInteger(n)&&n>0?Math.min(n,Math.max(1,limit)):1;
};
const diagnostics=[];
const DIAGNOSTIC_LIMIT=3000;
function clearDiagnostics(){
 diagnostics.length=0;
 el('diagnosticEntries').replaceChildren();
 el('diagnosticCount').textContent='0';
 el('diagnosticSummary').textContent='尚无诊断记录';
}
function addDiagnostic(entry){
 let detail=String(entry.detail||'');
 // In human-readable EPUB diagnostics, summarize massive raw JSON replies.
 // Full replies remain available in the optional provider request log.
 if(entry.stage==='response'&&detail.startsWith('{"results":')){
  try{
   const result=JSON.parse(detail);
   detail=JSON.stringify({answerCount:result.results?.length,
    firstRows:result.results?.slice(0,10),note:'完整 API 回复见单独的模型请求日志'});
  }catch{detail=detail.slice(0,1500);}
 }
 const record={at:new Date().toISOString(),group:entry.group??null,
  stage:entry.stage||'general',level:entry.level||'info',
  message:String(entry.message||'').slice(0,4000),
  detail:detail.slice(0,3500),
  ...(entry.stats?{stats:entry.stats}:{})};
 diagnostics.push(record);
 if(diagnostics.length>DIAGNOSTIC_LIMIT)diagnostics.shift();
 const list=el('diagnosticEntries');
 const li=document.createElement('li');
 li.className='diagnostic-'+record.level;
 li.textContent=(record.group!==null?'第 '+(record.group+1)+' 组 · ':'')+
  '['+record.stage+'] '+record.message+(record.detail?'\n'+record.detail:'');
 list.append(li);
 if(list.children.length>DIAGNOSTIC_LIMIT)list.firstChild.remove();
 el('diagnosticCount').textContent=String(diagnostics.length);
 el('diagnosticSummary').textContent='已记录 '+diagnostics.length+' 项 · 警告 '+
  diagnostics.filter(x=>x.level==='warning').length+' · 错误 '+
  diagnostics.filter(x=>x.level==='error').length;
}
function apiConcurrencySuffix(){
 return apiReviewActive?' · API 同时最多 '+effectiveApiConcurrency+' 批':'';
}
function updateApiBatchSummary(){
 updateRequestPlan('首轮审核计划：'+totalPlannedReviewRequests+
  ' 批 · 已结束 '+completedInitialRequests.size+'/'+totalPlannedReviewRequests+
  ' 批 · 正在运行 '+runningInitialRequests.size+' 批'+apiConcurrencySuffix()+
  '（补交／重试另计）');
}
const initialRequestOffset=index=>plannedByChunk.slice(0,index).reduce((n,v)=>n+(v||0),0);
const phasePercent=(index,fraction,planning=false)=>{
 const relative=(index+Math.max(0,Math.min(1,fraction)))/Math.max(1,totalChunks);
 return planning?5+43*relative:50+43*relative;
};
function updateRequestPlan(text){el('requestPlan').textContent=text;}
function setManualMeta(text){el('manualReviewMeta').textContent=text;}
function revokeDownloadObjectUrlLater(url,delayMs){
 const timer=setTimeout(()=>URL.revokeObjectURL(url),delayMs);
 // In Chrome this is a numeric timer. Node tests return an object that
 // would otherwise keep an already-completed test process alive for a minute.
 if(timer&&typeof timer==='object'&&typeof timer.unref==='function')timer.unref();
}
function showManualNotice(kind,text){
 const target=el('manualReviewNotice');
 target.hidden=!text;target.dataset.kind=kind||'info';
 target.textContent=text||'';
}
const requestOrdinal=(index,batchNumber)=>initialRequestOffset(index)+(batchNumber||1);
let activeRecovery=null,resumeResolver=null,continuationResolver=null;
function waitForBookContinuation(remaining,groups,mode,unstarted=0){
 el('reviewContinuation').hidden=false;
 el('reviewContinuationSummary').textContent='本轮已有 '+groups+' 组、'+remaining+
  ' 个目标仍未审核成功'+(unstarted?'；另有 '+unstarted+' 组尚未开始首轮审核':'')+
  '。有效答案和原有 EPUB 均已保留；继续时不会重做已经审核成功的目标。';
 el('continuationMode').value=mode==='manual'?'manual':'api';
 progress(Math.max(unstarted?50:93,el('progress').value),'审核暂停，等待继续',
  '剩余 '+remaining+' 个未完成目标'+(unstarted?'，'+unstarted+' 组尚未开始':'')+
  '。可选择 API、手动继续，或者将剩余目标全部按 null 保留原文后生成 EPUB。');
 return new Promise(resolve=>{continuationResolver=resolve;});
}
el('finishWithNull').addEventListener('click',()=>{
 if(!continuationResolver)return;
 const resolve=continuationResolver;continuationResolver=null;
 el('reviewContinuation').hidden=true;
 addDiagnostic({stage:'book-null-finalize',level:'warning',
  message:'用户明确选择：已完成答案保持不变，剩余未完成目标全部按 null 处理。'});
 resolve('null');
});
el('continueReview').addEventListener('click',()=>{
 if(!continuationResolver)return;
 const resolve=continuationResolver;continuationResolver=null;
 const mode=el('continuationMode').value==='manual'?'manual':'api';
 el('reviewContinuation').hidden=true;
 resolve(mode);
});
class RecoverableEngineDisconnect extends Error {
 constructor(reason){super(reason);this.name='RecoverableEngineDisconnect';}
}
function askToResume(){
 if(resumeResolver){const resume=resumeResolver;resumeResolver=null;el('retryConnection').hidden=true;resume();}
}
el('retryConnection').addEventListener('click',askToResume);
function exportTextFile(text,filename){
 const blob=new Blob([text],{type:'text/plain;charset=utf-8'});
 const url=URL.createObjectURL(blob);
 const a=document.createElement('a');a.href=url;a.download=filename;
 document.body.append(a);a.click();a.remove();
 revokeDownloadObjectUrlLater(url,30000);
}
el('downloadPrompt').addEventListener('click',()=>{
 const value=el('manualPrompt').value;
 if(!value){el('manualStatus').textContent='当前没有可下载的提示词';return;}
 const id=String(manualRequest?.requestId||activeRecovery?.pending?.request?.requestId||'prompt')
  .replace(/[^A-Za-z0-9_-]/gu,'_');
 exportTextFile(value,'Korean-EPUB-Annotator-manual-'+id+'.txt');
 el('manualStatus').textContent='提示词已下载为 TXT';
});
el('importAnswer').addEventListener('click',()=>el('manualAnswerFile').click());
el('manualAnswerFile').addEventListener('change',async event=>{
 const file=event.target.files?.[0];event.target.value='';
 if(!file)return;
 if(!/\.(?:json|txt)$/iu.test(file.name)||file.size>16*1024*1024){
  el('manualStatus').textContent='请选择不超过 16 MiB 的 JSON 或 TXT 答案';return;
 }
 try{
  const text=await file.text();
  el('manualAnswer').value=text;
  el('manualStatus').textContent='已导入 '+file.name+'，可提交校验';
  if(!currentPort&&activeRecovery?.pending)el('manualStatus').textContent+='；后台恢复后将沿用这份答案';
 }catch(error){el('manualStatus').textContent='读取答案文件失败：'+error.message;}
});

function setTab(name){
 for(const [tab,panel] of tabs){
  const chosen=tab===name;
  el(tab).classList.toggle('active',chosen);
  el(tab).setAttribute('aria-selected',String(chosen));
  el(panel).hidden=!chosen;
 }
}
for(const [tab] of tabs)el(tab).addEventListener('click',()=>setTab(tab));
const phaseMessages={
 dictionary:'正在准备词典与 Kiwi 引擎',
 tokenizer:'正在加载韩语分词模型',
 analysis:'正在分析韩语正文',
 'analysis-batch':'正在批量分析韩语段落',
 'analysis-paragraph':'正在分析段落',
 model:'大模型正在审核词源'
};
function progress(pct,phase,status,error=false){
 el('progress').value=Math.max(0,Math.min(100,Math.round(pct)));
 el('percentage').textContent=Math.round(el('progress').value)+'%';
 if(phase!==undefined)el('phase').textContent=phase;
 if(status!==undefined)el('status').textContent=status;
 el('status').classList.toggle('error',error);
}
function downloadBook(){
 if(!download)return;
 const blob=new Blob([download.bytes],{type:'application/epub+zip'});
 const url=URL.createObjectURL(blob);
 const anchor=document.createElement('a');anchor.href=url;anchor.download=download.filename;
 document.body.append(anchor);anchor.click();anchor.remove();
 revokeDownloadObjectUrlLater(url,60000);
}
el('downloadEpub').addEventListener('click',downloadBook);
el('toggleDiagnostics').addEventListener('click',()=>{
 const panel=el('epubDiagnostics');
 panel.hidden=!panel.hidden;
 el('toggleDiagnostics').setAttribute('aria-expanded',String(!panel.hidden));
});
el('downloadDiagnostics').addEventListener('click',()=>{
 exportTextFile(diagnostics.map(d=>
  d.at+' | '+(d.group===null?'整本书':'第 '+(d.group+1)+' 组')+
  ' | '+d.level+' | '+d.stage+'\n'+d.message+
  (d.detail?'\n'+d.detail:'')+(d.stats?'\n'+JSON.stringify(d.stats):'')
 ).join('\n\n'),'Korean-EPUB-diagnostics.txt');
});
el('dropZone').addEventListener('click',()=>{if(!busy)el('epubFile').click();});
el('dropZone').addEventListener('keydown',event=>{
 if((event.key==='Enter'||event.key===' ')&&!busy){event.preventDefault();el('epubFile').click();}
});
el('dropZone').addEventListener('dragover',event=>{
 event.preventDefault();if(!busy)el('dropZone').classList.add('dragging');
});
el('dropZone').addEventListener('dragleave',()=>el('dropZone').classList.remove('dragging'));
el('dropZone').addEventListener('drop',event=>{
 event.preventDefault();el('dropZone').classList.remove('dragging');
 if(!busy&&event.dataTransfer.files.length)handleFile(event.dataTransfer.files[0]);
});
el('epubFile').addEventListener('change',event=>{
 const f=event.target.files?.[0];if(f&&!busy)handleFile(f);
 event.target.value='';
});
el('copyPrompt').addEventListener('click',async()=>{
 try{await navigator.clipboard.writeText(el('manualPrompt').value);
  el('manualStatus').textContent='请求已复制';}
 catch{el('manualPrompt').focus();el('manualPrompt').select();
  el('manualStatus').textContent='请手动复制选中的请求';}
});
function submitManualAnswer(){
 const recovery=activeRecovery;
 const answer=el('manualAnswer').value.trim();
 if(!answer){el('manualStatus').textContent='请先粘贴或导入 JSON/TXT 答案';return;}
 if(recovery?.awaitingCorrection&&answer===recovery.lastRejectedAnswer){
  showManualNotice('validation','这仍是上一份没有通过校验的答案。\n已验证的部分已经保留；请按当前补交提示词，只提交剩余目标的新答案。\n重复提交原答案不会完成这一批。');
  el('manualStatus').textContent='未发送：补交答案与上次未通过的内容相同。';
  return;
 }
 if(!manualRequest||!currentPort){
  if(!recovery?.pending?.request){
   el('manualStatus').textContent='当前没有正在审核的目标，请先上传 EPUB';return;
  }
  // A recovered worker may create a new batch ID. Keep the old answer and
  // let the backend validate it again after checking the complete prompt.
  recovery.pending.answer=answer;
  recovery.pending.submitted=true;
  el('manualStatus').textContent='答案已留在当前页面；后台重连后将自动校验并继续';
  askToResume();return;
 }
 let response=answer;
 const alias=recovery?.alias;
 if(alias){
  const rebound=transferManualAnswer(answer,alias.request,manualRequest,alias.acceptedRows);
  if(rebound)response=rebound;
  else if(answer.includes(alias.request.requestId)&&
          alias.request.requestId!==manualRequest.requestId){
   el('manualStatus').textContent='旧答案无法安全对应当前批次。请复制最新提示词重新审核';return;
  }
 }
 if(recovery)recovery.lastSent={request:manualRequest,answer:response,
   submitted:true,acceptedRows:recovery.acceptedPartial||[]};
 // Mark as submitted before sending: the port may disconnect synchronously,
 // and the recovery snapshot must not mistake a sent response for a draft.
 el('submitAnswer').disabled=true;
 try{
  const submittedId=manualRequest.requestId;
  currentPort.postMessage({type:'MANUAL_REVIEW_RESPONSE',operationId,
   requestId:submittedId,text:response});
  if(el('submitAnswer').disabled)
   el('manualStatus').textContent=recovery?.awaitingCorrection?
    '补交答案已提交，正在校验剩余目标…':
    '已提交，等待后台校验；若连接断开将自动恢复本批次';
 }catch(error){
  el('submitAnswer').disabled=false;
  if(recovery){
   recovery.pending={request:manualRequest,answer,submitted:true,
    acceptedRows:recovery.acceptedPartial||[]};
  }
  el('manualStatus').textContent='提交时连接断开，答案已保留：'+error.message;
  askToResume();
 }
}
el('submitAnswer').addEventListener('click',submitManualAnswer);
el('pauseManualReview').addEventListener('click',()=>{
 if(!manualRequest||!currentPort||!operationId){
  el('manualStatus').textContent='当前没有正在等待手动审核的目标。';return;
 }
 try{
  currentPort.postMessage({type:'PAUSE_MANUAL_REVIEW',operationId});
  el('pauseManualReview').disabled=true;
  el('manualStatus').textContent='正在保存本轮已验证的答案，返回继续审核选项…';
 }catch(error){
  el('pauseManualReview').disabled=false;
  el('manualStatus').textContent='暂停失败：'+String(error.message||error);
 }
});
el('epubApiConcurrency').addEventListener('change',async event=>{
 const n=saneConcurrency(event.target.value);
 event.target.value=String(n);
 await chrome.storage.local.set({epubApiConcurrency:n});
});
for(const id of ['hanjaMode','loanwordMode'])el(id).addEventListener('change',async event=>{
 await chrome.storage.local.set({[id]:event.target.checked});
});
async function init(){
 const settings=await chrome.storage.local.get(['hanjaMode','loanwordMode','manualModelReview','epubApiConcurrency']);
 el('hanjaMode').checked=settings.hanjaMode!==false;
 el('loanwordMode').checked=settings.loanwordMode!==false;
 el('manualPanel').hidden=settings.manualModelReview!==true;
 el('epubApiConcurrency').value=String(saneConcurrency(settings.epubApiConcurrency));
 el('epubApiConcurrencyRow').hidden=settings.manualModelReview===true;
 chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local')return;
  if(changes.manualModelReview&&!busy){
   el('manualPanel').hidden=changes.manualModelReview.newValue!==true;
   el('epubApiConcurrencyRow').hidden=changes.manualModelReview.newValue===true;
  }
  if(changes.epubApiConcurrency&&!busy)
   el('epubApiConcurrency').value=String(saneConcurrency(changes.epubApiConcurrency.newValue));
  if(changes.hanjaMode)el('hanjaMode').checked=changes.hanjaMode.newValue!==false;
  if(changes.loanwordMode)el('loanwordMode').checked=changes.loanwordMode.newValue!==false;
 });
}
init().catch(error=>progress(0,'设置初始化失败',error.message,true));

function runChunkAttempt(sentences,context,book,index,modes,progressive,recovery,planOnly=false,deferReview=false,onPlanReady=null,reviewGate=null,sessionHanjaSeed=[],bookRunId=null,apiConcurrency=1,onReviewPaused=null){
 return new Promise((resolve,reject)=>{
  let finished=false,heartbeat=null;
  const portOperationId=crypto.randomUUID();
  if(!deferReview)operationId=portOperationId;
  if(!deferReview)manualRequest=null;
  recovery.alias=null;recovery.plannedBatches=0;recovery.currentBatchNumber=0;
  recovery.released=false;
  let port;
  const finish=(error,data)=>{
   if(finished)return;
   finished=true;
   if(heartbeat!==null)clearInterval(heartbeat);
   livePorts.delete(portOperationId);
   if(currentPort===port){
    currentPort=null;manualRequest=null;
    el('submitAnswer').disabled=false;
   }
   try{port?.disconnect();}catch{}
   if(error)reject(error);else resolve(data);
  };
  const preserveManual=()=>{
   if(!manualRequest)return;
   const last=recovery.lastSent;
   const sent=last?.request?.requestId===manualRequest.requestId&&
     el('submitAnswer').disabled===true;
   recovery.pending={
    request:manualRequest,
    answer:el('manualAnswer').value.trim()||(sent?last.answer:''),
    submitted:Boolean(sent),
    acceptedRows:[...(recovery.acceptedPartial||[])]
   };
  };
  const sendResumed=(event,text)=>{
   recovery.lastSent={request:event,answer:text,submitted:true,acceptedRows:[]};
   try{
    port.postMessage({type:'MANUAL_REVIEW_RESPONSE',operationId:portOperationId,
      requestId:event.requestId,text});
    el('submitAnswer').disabled=true;
    el('manualStatus').textContent='已重新连接并恢复此前的有效答案，正在校验当前批次…';
   }catch(error){
    recovery.pending={request:event,answer:text,submitted:true,acceptedRows:[]};
    finish(new RecoverableEngineDisconnect('恢复手动审核时连接再次中断：'+error.message));
   }
  };
  try{port=chrome.runtime.connect({name:'KRA_SENTENCE_STREAM_V1'});}
  catch(error){reject(new RecoverableEngineDisconnect('无法连接标注引擎：'+error.message));return;}
  currentPort=port;
  livePorts.set(portOperationId,port);
  port.onDisconnect.addListener(()=>{
   if(finished)return;
   preserveManual();
   const error=chrome.runtime.lastError?.message||'后台服务线程连接意外断开';
   finish(new RecoverableEngineDisconnect(error));
  });
  port.onMessage.addListener(event=>{
   if(finished||(event.operationId&&event.operationId!==portOperationId))return;
   if(event.type==='PONG')return;
   if(event.type==='DIAGNOSTIC'){
    addDiagnostic({...(event.diagnostic||{}),group:index});
    return;
   }
   if(event.type==='EPUB_REVIEW_CHECKPOINT'){
    for(const row of event.rows||[]){
     if(!row||typeof row.sentenceId!=='string'||typeof row.surface!=='string'||
        !Number.isInteger(row.start)||!Number.isInteger(row.end))continue;
     const key=JSON.stringify([row.sentenceId,row.start,row.end,row.surface]);
     recovery.acceptedCheckpoints.set(key,row);
    }
    return;
   }
   if(event.type==='EPUB_REJECTED_CHECKPOINT'){
    if(typeof event.key==='string'&&event.key.length<100000&&
       event.record&&typeof event.record==='object')
     recovery.rejectedCheckpoints.set(event.key,event.record);
    return;
   }
   if(event.type==='REVIEW_PLAN'){
    recovery.plannedBatches=Number(event.plannedBatches)||0;
    if(deferReview){
     try{onPlanReady?.(recovery.plannedBatches,event.sessionHanjaSnapshot??sessionHanjaSeed);}
     catch(error){finish(error);return;}
     Promise.resolve(reviewGate).then(nextMode=>{
      if(finished)return;
      recovery.released=true;
      port.postMessage({type:'RUN_REVIEW',operationId:portOperationId,
       ...(nextMode==='api'||nextMode==='manual'||nextMode==='null'?{mode:nextMode}:{})});
     }).catch(error=>finish(error));
    }
    return;
   }
   if(event.type==='REVIEW_PAUSED'){
    el('pauseManualReview').hidden=true;
    recovery.reviewContinuation=true;
    recovery.unansweredTargets=Number(event.unansweredTargets)||0;
    addDiagnostic({group:index,stage:'review-paused',level:'warning',
     message:'本轮自动审核结束，仍有 '+recovery.unansweredTargets+
      ' 个目标需要继续；当前组的有效答案及原始分词目标已保留。'});
    onReviewPaused?.({port,operationId:portOperationId,
     remaining:recovery.unansweredTargets,group:index});
    return;
   }
   if(event.type==='REVIEW_CONTINUATION_ERROR'){
    addDiagnostic({group:index,stage:'review-continuation-error',level:'warning',
     message:'无法启动继续审核：'+(event.error||'未知错误')});
    return;
   }
   if(event.type==='REVIEW_CONTINUATION_STARTED'){
    recovery.reviewContinuation=true;
    addDiagnostic({group:index,stage:'review-continuation',level:'info',
     message:'第 '+(event.continuationPass||1)+' 轮继续审核：'+
      (event.requestKind==='manual'?'手动':'API')+
      '，仅审核 '+(event.unansweredTargets||0)+' 个未完成目标'});
    return;
   }
   if(event.type==='MODEL_BATCH_START'){
    recovery.currentBatchNumber=event.batchNumber||1;
    if(event.continuation===true){
     progress(Math.max(el('progress').value,93),'正在继续审核词源',
      '第 '+(index+1)+' 组继续审核剩余 '+(event.targets||0)+' 个目标。');
     return;
    }
    if(apiReviewActive){
     const ordinal=requestOrdinal(index,recovery.currentBatchNumber);
     runningInitialRequests.add(ordinal);
     addDiagnostic({group:index,stage:'model-batch',level:'info',
      message:'首轮第 '+ordinal+'/'+totalPlannedReviewRequests+' 批开始，'+(event.targets||0)+' 个待审目标'});
     updateApiBatchSummary();
     progress(el('progress').value,'正在并发审核词源',
      '首轮批次已完成 '+completedInitialRequests.size+'/'+totalPlannedReviewRequests+
      '，当前运行 '+runningInitialRequests.size+' 批；最大并发 '+effectiveApiConcurrency+'。');
     return;
    }
    const ordinal=requestOrdinal(index,recovery.currentBatchNumber);
    updateRequestPlan('首轮审核计划：'+totalPlannedReviewRequests+
      ' 批 · 正在处理第 '+ordinal+'/'+totalPlannedReviewRequests+
      ' 批（错误答案补交与 API 重试另计）');
    progress(phasePercent(index,.70), '正在进行模型审核',
      '首轮审核第 '+ordinal+'/'+totalPlannedReviewRequests+
      ' 批 · 本批目标 '+(event.targets||0)+' 个');
    return;
   }
   if(event.type==='MODEL_BATCH_DONE'){
    if(event.continuation===true)return;
    const ordinal=requestOrdinal(index,event.batchNumber||1);
    if(apiReviewActive){
     runningInitialRequests.delete(ordinal);
     completedInitialRequests.add(ordinal);
     updateApiBatchSummary();
     addDiagnostic({group:index,stage:'model-batch-done',level:'info',
      message:'首轮第 '+ordinal+' 批已结束；已处理 '+completedInitialRequests.size+'/'+totalPlannedReviewRequests+' 批（最终完整性以组结论为准）'});
     return;
    }
    updateRequestPlan('首轮审核计划：'+totalPlannedReviewRequests+
      ' 批 · 已完成第 '+ordinal+'/'+totalPlannedReviewRequests+
      ' 批（不含可能的补交／重试）');
    return;
   }
   if(event.type==='RESULTS'){
    try{ingestPipelineResult(book,event);}
    catch(error){finish(new Error('EPUB 结果映射出错：'+error.message));}
    return;
   }
   if(event.type==='MANUAL_REVIEW_REQUEST'){
    el('pauseManualReview').hidden=false;
    el('pauseManualReview').disabled=false;
    const repeatedId=recovery.lastRequestId===event.requestId&&!recovery.pending;
    manualRequest=event;
    currentPort=port;operationId=portOperationId;activeRecovery=recovery;
    el('manualPanel').hidden=false;
    if(repeatedId){
     showManualNotice('recovery','后台重复发送同一个 batch_id 的请求，这不是新的首轮批次。当前答案与提示词已保留，请勿重复向模型发问。');
     setManualMeta('重复提示 · batch_id：'+event.requestId+' · 本书首轮计划仍为 '+totalPlannedReviewRequests+' 批');
     return;
    }
    recovery.lastRequestId=event.requestId;
    recovery.awaitingCorrection=false;recovery.lastRejectedAnswer=null;
    recovery.correctionCount=0;
    const ordinal=requestOrdinal(index,event.batchNumber||1);
    setManualMeta('首轮第 '+ordinal+'/'+totalPlannedReviewRequests+
     ' 批 · 本批 '+(event.targetCount??'?')+' 个目标 · batch_id：'+event.requestId);
    showManualNotice(null,'');
    el('manualPrompt').value=event.text||event.prompt||'';
    el('submitAnswer').disabled=false;
    const prior=recovery.pending;
    const history=recovery.history.get(manualRequestIdentity(event));
    if(prior){
     recovery.pending=null;
     if(sameManualTargets(prior.request,event)){
      recovery.alias={request:prior.request,acceptedRows:prior.acceptedRows,matched:true};
      showManualNotice('recovery','后台连接恢复，已确认待审核原句、目标及候选项一致。这是同一批次的断线恢复，不是新增审核请求。');
      el('manualAnswer').value=prior.answer||'';
      const resumed=prior.answer?
       transferManualAnswer(prior.answer,prior.request,event,prior.acceptedRows):null;
      if(prior.submitted&&resumed){sendResumed(event,resumed);return;}
      el('manualStatus').textContent=
       '断线恢复：保留旧答案和已验证结果，可提交原 JSON；必要时会安全替换 batch_id。';
     }else{
      recovery.alias={request:prior.request,acceptedRows:[],matched:false};
      showManualNotice('validation','后台已重连，但审核原句、目标或候选发生变化，旧答案不能安全套用。请重新发送最新提示词。');
      el('manualAnswer').value=prior.answer||'';
      el('manualStatus').textContent='断线后请求已变化，原答案保留供参考，请重新审核。';
     }
    }else if(history){
     showManualNotice('recovery','已识别到之前成功提交过的相同目标，正在检查能否自动复用。');
     const resumed=transferManualAnswer(history.answer,history.request,event,
       history.acceptedRows||[]);
     if(resumed){sendResumed(event,resumed);return;}
     el('manualAnswer').value='';
     el('manualStatus').textContent='后台已恢复，但原答案无法匹配新批次，需重新提交。';
    }else{
     recovery.alias=null;
     el('manualAnswer').value='';
     recovery.acceptedPartial=[];
     el('manualStatus').textContent='待审核：首轮第 '+ordinal+'/'+totalPlannedReviewRequests+
      ' 批；如需要补交，会在上方明确显示原因。';
    }
    progress(phasePercent(index,.80),'等待手动模型答案',
     '首轮审核第 '+ordinal+'/'+totalPlannedReviewRequests+
     ' 批。请复制或下载提示词，然后粘贴或导入完整 JSON。');
    return;
   }
   if(event.type==='MANUAL_REVIEW_PAUSED'){
    el('pauseManualReview').hidden=true;
    manualRequest=null;
    el('submitAnswer').disabled=false;
    el('manualStatus').textContent='本轮手动审核已暂停，已保存 '+
     (event.acceptedCount||0)+' 条有效答案，准备显示继续审核选项。';
    return;
   }
   if(event.type==='MANUAL_REVIEW_ERROR'){
    if(manualRequest&&event.requestId&&event.requestId!==manualRequest.requestId){
     showManualNotice('validation','收到不属于当前 batch_id 的校验反馈，已忽略以避免将另一批答案写到本批。');
     return;
    }
    const ordinal=requestOrdinal(index,manualRequest?.batchNumber||recovery.currentBatchNumber||1);
    const correction=event.errorKind==='targeted_correction'&&!!event.repairPrompt;
    recovery.lastRejectedAnswer=recovery.lastSent?.answer||el('manualAnswer').value.trim();
    recovery.awaitingCorrection=correction;
    if(correction)recovery.correctionCount=(recovery.correctionCount||0)+1;
    const accepted=Number.isInteger(event.acceptedCount)?event.acceptedCount:
     Array.isArray(event.acceptedRows)?event.acceptedRows.length:0;
    const remaining=Number.isInteger(event.remainingCount)?event.remainingCount:
     Array.isArray(event.invalidTargetIds)?event.invalidTargetIds.length:null;
    const total=Number.isInteger(event.totalTargetCount)?event.totalTargetCount:
     manualRequest?.targetCount;
    const detail=event.error||'答案未通过校验';
    if(correction){
     setManualMeta('首轮第 '+ordinal+'/'+totalPlannedReviewRequests+
      ' 批 · 补交第 '+recovery.correctionCount+' 次 · 已保存 '+
      accepted+'/'+(total??'?')+' 条 · 剩余 '+(remaining??'?')+
      ' 条 · 同一 batch_id：'+(manualRequest?.requestId||'?'));
     showManualNotice('correction','需要补交，但这不是新的首轮批次。\n'+
      '上一份模型答案有 '+(remaining??'部分')+
      ' 条未通过验证，已成功保存 '+accepted+
      ' 条。下面的提示词仅包含尚未通过的目标。\n'+
      '请复制新的补交提示词重新询问 LLM，只需返回这些剩余目标的 JSON。\n错误详情：'+detail);
     updateRequestPlan('首轮计划 '+totalPlannedReviewRequests+' 批 · 当前第 '+ordinal+
      ' 批进入第 '+recovery.correctionCount+' 次补交（不计为新的首轮批次）');
     el('manualStatus').textContent='补交提示词已生成；请查看上方原因，并用新模型答案替换输入框内容。';
    }else{
     setManualMeta('首轮第 '+ordinal+'/'+totalPlannedReviewRequests+
      ' 批 · 答案校验未通过 · batch_id：'+(manualRequest?.requestId||'?'));
     showManualNotice('validation','答案校验失败，当前批次仍在等待。\n'+
      '这不是新的 LLM 请求。请修改 JSON 后重新提交；如果没有补交提示词，可以直接修改原答案。\n错误详情：'+detail);
     el('manualStatus').textContent='校验失败：请先修复当前答案；无需无故再向模型发问。';
    }
    if(event.repairPrompt)el('manualPrompt').value=event.repairPrompt;
    if(Array.isArray(event.acceptedRows)){
     const merged=new Map((recovery.acceptedPartial||[]).map(row=>[row.t,row]));
     for(const row of event.acceptedRows)if(typeof row?.t==='string')merged.set(row.t,row);
     recovery.acceptedPartial=[...merged.values()];
    }
    recovery.lastSent=null;
    el('submitAnswer').disabled=false;
    return;
   }
   if(event.type==='MANUAL_REVIEW_ACCEPTED'){
    el('pauseManualReview').hidden=true;
    const accepted=recovery.lastSent;
    if(accepted){
     const identity=manualRequestIdentity(accepted.request);
     if(identity){
      // The last submitted JSON might be just a targeted correction. The
      // backend's MANUAL_REVIEW_ACCEPTED event contains the complete, safely
      // validated results of the entire batch, including earlier submissions.
      // Persist that final snapshot for connection recovery, not the last
      // partial JSON which would create another avoidable LLM retry.
      const rows=Array.isArray(event.acceptedRows)?event.acceptedRows:null;
      const repairs=Array.isArray(event.acceptedRepairs)?event.acceptedRepairs:[];
      const answer=rows?JSON.stringify({
       batch_id:accepted.request.requestId,results:rows,
       ...(repairs.length?{repairs}:{})
      }):accepted.answer;
      recovery.history.set(identity,{request:accepted.request,
       answer,acceptedRows:[]});
     }
    }
    recovery.lastSent=null;recovery.acceptedPartial=[];
    manualRequest=null;
    el('submitAnswer').disabled=false;
    const ordinal=requestOrdinal(index,event.batchNumber||recovery.currentBatchNumber||1);
    const corrections=recovery.correctionCount||0;
    recovery.awaitingCorrection=false;recovery.lastRejectedAnswer=null;
    setManualMeta('首轮第 '+ordinal+'/'+totalPlannedReviewRequests+
     ' 批 · 后台校验通过 · 本批 '+(event.targetCount??'?')+' 条目标');
    showManualNotice('success','本批答案已全部通过校验。'+
      (corrections?'此前进行了 '+corrections+' 次补交；':'')+
      '正在继续标注 EPUB。');
    el('manualStatus').textContent='本批答案已验证，正在继续处理 EPUB…';
    return;
   }
   if(event.type==='LOCAL_PROGRESS'){
    const current=event.currentSentence||event.completedSentences||0;
    const fraction=sentences.length?Math.min(.55,current/sentences.length*.55):.1;
    progress(phasePercent(index,planOnly?fraction:Math.min(.23,fraction)),
     planOnly?'正在分析整本 EPUB':phaseMessages[event.stage]||'正在加载分析缓存',
     '正在处理第 '+(index+1)+'/'+totalChunks+' 组正文 · '+(event.stage||'加载中'));
    return;
   }
   if(event.type==='MODEL_PROGRESS'){
    if(planOnly||(deferReview&&!recovery.released))return; // Plan still waiting; no LLM request yet.
    const fraction=event.modelTotal?Math.min(1,event.modelCompleted/event.modelTotal):0;
    progress(phasePercent(index,.5+fraction*.45),
     '正在审核词源',
     '首轮审核第 '+requestOrdinal(index,recovery.currentBatchNumber||1)+'/'+totalPlannedReviewRequests+
     ' 批 · 已审核 '+(event.modelCompleted||0)+'/'+(event.modelTotal||0)+' 个目标');
    return;
   }
   if(event.type==='ERROR'){
    const reason=event.error||'标注引擎返回错误';
    addDiagnostic({group:index,stage:'error',level:'error',message:reason});
    if(/(?:[Cc]onnection|[Dd]isconnect|[Pp]ort closed|[Ww]orker terminat|连接断开|服务线程已停止|上下文已失效)/u.test(reason)){
     preserveManual();finish(new RecoverableEngineDisconnect(reason));
    }else finish(new Error(reason));
    return;
   }
   if(event.type==='DONE'){
    addDiagnostic({group:index,stage:'completed',level:event.reviewIncomplete?'warning':'info',
     message:event.reviewIncomplete?'当前正文组有 '+event.unansweredTargets+' 项未完成':
      '当前正文组完成',stats:event.stats});
    if(planOnly){
     if(event.preflight!==true){finish(new Error('本地预分析未完成，不能发送模型请求'));return;}
     finish(null,{...event,plannedBatches:recovery.plannedBatches});
     return;
    }
    if(event.reviewIncomplete||event.unansweredTargets){
     const reason=new Error('第 '+(index+1)+' 组仍有 '+(event.unansweredTargets||'部分')+
      ' 个审核目标未完成，已保留前面通过校验的答案。');
     reason.unansweredTargets=Number(event.unansweredTargets)||0;
     reason.epubChunkIndex=index;
     finish(reason);
    }else finish(null,event);
   }
  });
  heartbeat=setInterval(()=>{
   if(finished)return;
   try{port.postMessage({type:'KEEPALIVE',operationId:portOperationId});}
   catch(error){
    preserveManual();
    finish(new RecoverableEngineDisconnect('后台保活连接断开：'+error.message));
   }
  },20000);
  try{port.postMessage({type:'START',operationId:portOperationId,sentences,context,modes,
    progressiveAnnotation:progressive,planOnly,deferReview,reviewAll:false,forceRegenerate:false,
    epubBookSession:true,allowUserContinuation:true,sessionHanjaSeed,
    epubAcceptedRecovery:[...recovery.acceptedCheckpoints.values()],
    epubRejectedRecovery:[...recovery.rejectedCheckpoints.entries()],
    epubBookRunId:bookRunId,epubApiConcurrency:apiConcurrency});}
  catch(error){finish(new RecoverableEngineDisconnect('无法启动分析请求：'+error.message));}
 });
}
async function runChunk(sentences,context,book,index,modes,progressive,planOnly=false,deferReview=false,onPlanReady=null,reviewGate=null,sessionHanjaSeed=[],bookRunId=null,apiConcurrency=1,onReviewPaused=null){
 const recovery={history:new Map(),pending:null,acceptedPartial:[],
  lastSent:null,alias:null,lastRequestId:null,reviewContinuation:false,
  correctionCount:0,awaitingCorrection:false,lastRejectedAnswer:null,reconnectCount:0,
 acceptedCheckpoints:new Map(),rejectedCheckpoints:new Map()};
 activeRecovery=recovery;
 let consecutiveFailures=0;
 try{
  for(;;){
   try{
    const result=await runChunkAttempt(sentences,context,book,index,modes,progressive,recovery,planOnly,deferReview,onPlanReady,reviewGate,sessionHanjaSeed,bookRunId,apiConcurrency,onReviewPaused);
    el('retryConnection').hidden=true;
    return result;
   }catch(error){
    if(!(error instanceof RecoverableEngineDisconnect))throw error;
    consecutiveFailures++;recovery.reconnectCount++;
    addDiagnostic({group:index,stage:'engine-session-restart',level:'warning',
     message:'引擎连接中断，第 '+(index+1)+' 组需要重建分析会话；这是连接恢复，不是普通补交或继续审核。',
     detail:'之前完成的其他组仍保留。当前组重新分析的结果将按恢复规则校验，不能当作新首轮请求。'});
    const status='引擎连接中断，但前面已完成的 '+doneChunks+
     ' 组已保留；当前组会在重新连接后继续审核。'+
     (recovery.pending?'手动提示词和答案也已保留。':'');
    if(consecutiveFailures<=3){
     progress(el('progress').value,'正在自动恢复连接',status+
       ' 第 '+consecutiveFailures+'/3 次重试：'+error.message);
     await new Promise(resolve=>setTimeout(resolve,500*consecutiveFailures));
    }else{
     progress(el('progress').value,'连接暂不可用',status+
       ' 请点击“恢复连接并继续当前批次”，无需重新上传 EPUB。');
     el('retryConnection').hidden=false;
     await new Promise(resolve=>{resumeResolver=resolve;});
     consecutiveFailures=0;
    }
   }
  }
 }finally{
  if(activeRecovery===recovery)activeRecovery=null;
  el('retryConnection').hidden=true;
  resumeResolver=null;
 }
}

async function handleFile(file){
 if(busy)return;
 if(!/\.epub$/iu.test(file.name)){
  progress(0,'文件格式错误','请选择 .epub 文件（不是 .epub.zip）',true);return;
 }
 busy=true;download=null;
 clearDiagnostics();
 completedInitialRequests=new Set();runningInitialRequests=new Set();
 apiReviewActive=false;
 const parkedJobs=[];
 const bookRunId=crypto.randomUUID();
 addDiagnostic({stage:'book-session-start',level:'info',message:'新建整本 EPUB 审核任务（与已有任务的补交或继续审核不同）。',
  detail:JSON.stringify({bookRunId,filename:file.name})});
 let bookSessionHanja=[];
 el('downloadEpub').disabled=true;
 el('selectedFile').textContent=file.name+' · '+(file.size/1024/1024).toFixed(2)+' MiB';
 progress(1,'读取 EPUB','正在检查 EPUB 结构和阅读顺序…');
 try{
  const config=await chrome.storage.local.get(['manualModelReview','progressiveAnnotation','hanjaMode','loanwordMode','epubApiConcurrency']);
  const modes={hanja:config.hanjaMode!==false,loanword:config.loanwordMode!==false};
  const requestedApiConcurrency=saneConcurrency(config.epubApiConcurrency);
  const usingApi=config.manualModelReview!==true;
  el('epubApiConcurrency').disabled=true;
  if(!modes.hanja&&!modes.loanword)throw Error('请在右侧设置中至少开启一种标注类型');
  el('manualPanel').hidden=config.manualModelReview!==true;
  el('manualStatus').textContent='';
  setManualMeta('尚未开始模型审核。');
  showManualNotice(null,'');
  el('manualPrompt').value='';el('manualAnswer').value='';
  el('pauseManualReview').hidden=true;
  const book=openEpub(await file.arrayBuffer(),file.name);
  // Larger chunks reduce artificial splitting before the model's own
  // token-aware budgeter runs. The batch budget, not a 75-paragraph cutoff,
  // determines how many actual requests are needed.
  const chunks=sentenceChunks(book.sentences,{maxSentences:180,maxCharacters:120000});
  const progressive=config.progressiveAnnotation===true;
  totalChunks=chunks.length;doneChunks=0;
  plannedByChunk=new Array(totalChunks).fill(0);totalPlannedReviewRequests=0;
  progress(5,'正在分析整本 EPUB','共 '+book.stats.chapters+' 个正文文件、'+book.stats.paragraphs+
    ' 个韩语段落、'+book.stats.characters.toLocaleString()+' 字符。本阶段不会发送任何 LLM 请求。');
  updateRequestPlan('正在一次性分析全书、保存真实首轮批次计划；尚未发送请求。');
  // Phase 1: each chunk goes through local dictionary analysis ONCE and parks
  // its still-live worker pipeline just before the first manual/API request.
  // All review gates are kept closed until the entire book is analyzed.
  for(let index=0;index<chunks.length;index++){
   const group=chunks[index],context=group.map(x=>x.text).join('\n');
   let resolvePlan,rejectPlan,releaseReview,cancelReview;
   let observedPlan=null;
   const planning=new Promise((resolve,reject)=>{resolvePlan=resolve;rejectPlan=reject;});
   const reviewGate=new Promise((resolve,reject)=>{releaseReview=resolve;cancelReview=reject;});
   const job={
    index,group,releaseReview,cancelReview,
    task:null,planned:null,state:'planning',pauseInfo:null,remaining:0,
    ready:null,resolveReady:null,rejectReady:null
   };
   const resetReady=()=>{
    job.ready=new Promise((resolve,reject)=>{job.resolveReady=resolve;job.rejectReady=reject;});
    job.ready.catch(()=>{});
   };
   resetReady();
   job.resetReady=resetReady;
   job.task=runChunk(group,context,book,index,modes,progressive,false,true,(count,nextGlossary)=>{
    if(!Number.isInteger(count)||count<0)throw Error('EPUB 预分析批次数量不合法');
    if(observedPlan!==null){
     if(count!==observedPlan){
      // A shorter plan is expected after restoring previously validated
      // target decisions from this exact interrupted EPUB group.
      if(count<observedPlan&&job.state!=='planning'){
       addDiagnostic({group:index,stage:'epub-recovery-plan',level:'info',
        message:'断线后从原已完成 '+observedPlan+' 批中恢复已审核目标；剩余新计划 '+count+' 批，不重发已恢复的答案。'});
      }else throw Error('断线恢复后审核计划异常变化，已停止避免误用旧答案');
     }
     return;
    }
    observedPlan=count;
    // Share only confirmed author-parenthesis evidence with later groups.
    // All local passes finish before any review gate opens.
    if(Array.isArray(nextGlossary))bookSessionHanja=nextGlossary;
    resolvePlan(count);
   },reviewGate,bookSessionHanja,bookRunId,requestedApiConcurrency,info=>{
    job.state='paused';job.pauseInfo=info;job.remaining=info.remaining;
    job.resolveReady({paused:true,remaining:info.remaining});
   });
   job.task.then(()=>{
    job.state='done';job.remaining=0;job.resolveReady({done:true});
   },error=>{
    job.state='failed';job.rejectReady(error);
   });
   // A failure before REVIEW_PLAN also rejects the plan promise. Attach a
   // listener immediately so an interrupted plan cannot become unhandled.
   job.task.catch(rejectPlan);
   parkedJobs.push(job);
   const planned=await planning;
   job.planned=planned;plannedByChunk[index]=planned;
   progress(phasePercent(index,1,true),'正在分析整本 EPUB',
    '已完成第 '+(index+1)+'/'+totalChunks+' 组的本地分析与审核预算；未发送任何 LLM 请求。');
  }
  totalPlannedReviewRequests=plannedByChunk.reduce((n,v)=>n+v,0);
  effectiveApiConcurrency=usingApi?saneConcurrency(requestedApiConcurrency,totalPlannedReviewRequests):1;
  apiReviewActive=usingApi;
  el('epubApiConcurrency').max=String(Math.max(1,totalPlannedReviewRequests));
  el('epubApiConcurrencyHint').textContent='当前计划 '+totalPlannedReviewRequests+
   ' 批；本次实际最大并发 '+effectiveApiConcurrency+'（不超过首轮计划总数）。';
  addDiagnostic({stage:'review-plan',level:'info',
   message:'全书首轮计划 '+totalPlannedReviewRequests+' 批；'+
    (usingApi?'API 请求最多同时 '+effectiveApiConcurrency+' 批':'手动审核逐批提交')});
  if(usingApi)updateApiBatchSummary();
  else updateRequestPlan('首轮审核计划：'+totalPlannedReviewRequests+
   ' 批（手动和 API 共用相同的计数方式；后续补交／重试另计）');
  progress(50,'全书本地分析完成',
   '所有审核目标与批次已经保存。现在开始执行 '+totalPlannedReviewRequests+' 批首轮模型审核。');
  // Phase 2: release each already-analyzed pipeline. No second local pass,
  // no batch re-budgeting and no duplicate prompt generated by preflight.
  // Retain live analysis and accepted results when automatic retries end.
  const settle=async jobs=>{
   const outcomes=await Promise.allSettled(jobs.map(job=>job.ready));
   const failures=outcomes.map((outcome,i)=>({outcome,job:jobs[i]}))
    .filter(row=>row.outcome.status==='rejected');
   if(failures.length){
    const known=failures.reduce((n,row)=>n+(Number(row.outcome.reason?.unansweredTargets)||0),0);
    if(known>0)addDiagnostic({stage:'book-incomplete',level:'error',
     message:'部分审核会话无法继续；'+failures.length+
      ' 组有未完成目标，已知 '+known+' 个。既有有效结果已保留。'});
    throw Error('有 '+failures.length+
    ' 组发生无法继续的引擎错误：'+failures.map(row=>
     '第 '+(row.job.index+1)+' 组：'+
     (Number(row.outcome.reason?.unansweredTargets)>0?
      row.outcome.reason.unansweredTargets+' 个目标；':'')+
     String(row.outcome.reason?.message||row.outcome.reason)).join('；'));
   }
  };
  // Manual sessions remain strictly sequential. Initial API groups are
  // released concurrently, exactly as in the preceding version.
  if(usingApi){
   for(const job of parkedJobs){job.state='running';job.releaseReview();}
   await settle(parkedJobs);
  }else{
   for(const job of parkedJobs){
    job.state='running';job.releaseReview();await settle([job]);
    if(job.state==='paused')break;
   }
  }
  doneChunks=parkedJobs.filter(job=>job.state!=='planning').length;
  let nextMode=usingApi?'api':'manual';
  while(parkedJobs.some(job=>job.state==='paused'||job.state==='planning')){
   const paused=parkedJobs.filter(job=>job.state==='paused');
   const untouched=parkedJobs.filter(job=>job.state==='planning');
   const allWaiting=parkedJobs.filter(job=>job.state==='paused'||job.state==='planning');
   const remaining=paused.reduce((total,job)=>total+job.remaining,0);
   addDiagnostic({stage:'book-review-paused',level:'warning',
    message:'当前有 '+paused.length+' 组、'+remaining+' 个目标未审核成功；'+
     untouched.length+' 组仍等待首轮请求。有效答案已保存，等待选择继续方式。'});
   updateRequestPlan('首轮计划 '+totalPlannedReviewRequests+
    ' 批 · 当前剩余 '+remaining+' 个目标 · 未开始 '+untouched.length+' 组');
   nextMode=await waitForBookContinuation(remaining,paused.length,nextMode,untouched.length);
   apiReviewActive=nextMode==='api';
   el('manualPanel').hidden=nextMode!=='manual';
   if(nextMode==='api')el('manualStatus').textContent='已切换到 API；只审核尚未完成的目标。';
   const start=job=>{
    const previous=job.state;
    job.resetReady();
    job.state='running';
    if(previous==='planning'){
     // Still at the original single-pass preflight gate: change provider
     // before issuing this group's first model request.
     job.releaseReview(nextMode);
     return;
    }
    const session=job.pauseInfo;
    if(!session?.port||!session.operationId)
     throw Error('第 '+(job.index+1)+' 组的原始会话已丢失，无法安全继续。');
    session.port.postMessage({type:'CONTINUE_REVIEW',
     operationId:session.operationId,mode:nextMode});
   };
   addDiagnostic({stage:'book-review-continue',level:'info',
    message:'用户选择'+(nextMode==='manual'?'手动':'API')+
     '继续审核剩余 '+remaining+' 个目标；不重新本地分析。'});
   if(nextMode==='manual'||nextMode==='null'){
    // Explicit null finalization must visit every parked group without
    // spawning new API requests, including groups still at their review gate.
    // One manual prompt at a time; another explicit suspension can return
    // to the mode selector before touching any later book groups.
    for(const job of allWaiting){
     start(job);await settle([job]);
     if(job.state==='paused')break;
    }
   }else{
    for(const job of allWaiting)start(job);
    await settle(allWaiting);
   }
   doneChunks=parkedJobs.filter(job=>job.state!=='planning').length;
  }
  el('reviewContinuation').hidden=true;
  continuationResolver=null;
  apiReviewActive=false;
  progress(93,'生成 EPUB','正在写入 XHTML 标注并重新封装书籍…');
  const appearance=await chrome.storage.local.get('annotationAppearance');
  const exported=exportEpub(book,appearance.annotationAppearance);
  download=exported;
  progress(100,'标注完成','完成 '+exported.conversions+' 处标注；已自动下载 '+exported.filename);
  updateRequestPlan('首轮审核计划 '+totalPlannedReviewRequests+' 批 · 全书已完成。');
  el('downloadEpub').disabled=false;
  downloadBook();
 }catch(error){
  el('pauseManualReview').hidden=true;
  el('reviewContinuation').hidden=true;
  continuationResolver=null;
  // Never strand a worker-side review gate after a failed or cancelled book.
  for(const job of parkedJobs)job.cancelReview(new Error('本书处理已结束，取消未开始的模型审核。'));
  for(const [id,port] of livePorts){
   try{port.postMessage({type:'CANCEL',operationId:id});}catch{}
  }
  addDiagnostic({stage:'book-error',level:'error',message:String(error.message||error)});
  download=null;el('downloadEpub').disabled=true;
  progress(el('progress').value,'标注未完成',String(error.message||error),true);
 }finally{busy=false;apiReviewActive=false;el('epubApiConcurrency').disabled=false;currentPort=null;operationId=null;manualRequest=null;}
}

// Export for isolated Chrome-port integration tests; the actual extension UI
// continues to invoke this function through handleFile.
export {runChunk,handleFile};
