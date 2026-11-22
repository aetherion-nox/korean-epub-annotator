// EPUB-only shared API concurrency. Every worker pipeline for one book uses
// the same run identity; default website and SRT pipelines never enter it.
const books=new Map();
const integer=(v,d)=>Number.isSafeInteger(v)&&v>0?v:d;
export function activeEpubApiRequests(bookId){
 return books.get(bookId)?.active||0;
}
export function acquireEpubApiSlot(config={},signal){
 const id=config.epubBookRunId;
 if(typeof id!=='string'||!id||!config.epubBookSession)
  return Promise.resolve(()=>{});
 const limit=Math.min(10000,integer(config.epubApiConcurrency,1));
 let book=books.get(id);
 if(!book){
  book={active:0,limit,queue:[]};books.set(id,book);
 }
 // Limit is fixed for a running book. Other operations always have a
 // different run ID, so their budgets are isolated.
 const cleanup=()=>{if(!book.active&&!book.queue.length&&books.get(id)===book)books.delete(id);};
 const pump=()=>{
  while(book.active<book.limit&&book.queue.length){
   const request=book.queue.shift();
   if(request.signal?.aborted){request.reject(request.signal.reason||Error('Aborted'));continue;}
   book.active++;
   request.signal?.removeEventListener('abort',request.cancel);
   let released=false;
   request.resolve(()=>{
    if(released)return;
    released=true;book.active--;pump();cleanup();
   });
  }
  cleanup();
 };
 if(signal?.aborted)return Promise.reject(signal.reason||Error('Aborted'));
 return new Promise((resolve,reject)=>{
  const request={signal,resolve,reject,cancel:null};
  request.cancel=()=>{
   const at=book.queue.indexOf(request);
   if(at>=0)book.queue.splice(at,1);
   signal?.removeEventListener('abort',request.cancel);
   reject(signal?.reason||Error('Aborted'));
   pump();
  };
  book.queue.push(request);
  signal?.addEventListener('abort',request.cancel,{once:true});
  pump();
 });
}
