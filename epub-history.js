const DATABASE='kra-epub-history';
const DEFAULT_LIMIT=10;
const STORE_NAMES=['books','files','settings'];

function request(operation){
 return new Promise((resolve,reject)=>{
  operation.onsuccess=()=>resolve(operation.result);
  operation.onerror=()=>reject(operation.error);
 });
}

async function transact(stores,mode,action){
 const opening=indexedDB.open(DATABASE,1);
 opening.onupgradeneeded=()=>{
  const db=opening.result;
  db.createObjectStore('books',{keyPath:'id',autoIncrement:true});
  db.createObjectStore('files');
  db.createObjectStore('settings');
 };
 const db=await request(opening);
 try{
  const tx=db.transaction(stores,mode);
  const done=new Promise((resolve,reject)=>{
   tx.oncomplete=resolve;
   tx.onabort=()=>reject(tx.error||Error('历史记录存储已中断'));
  });
  const result=Promise.resolve().then(()=>action(tx)).catch(error=>{
   if(mode==='readwrite'){
    try{tx.abort();}catch{} // The failed IndexedDB request may already have aborted it.
   }
   throw error;
  });
  const [value]=await Promise.all([result,done]);
  return value;
 }finally{db.close();}
}

async function readLimit(tx){
 return (await request(tx.objectStore('settings').get('limit'))) ?? DEFAULT_LIMIT;
}

async function trimHistory(tx,limit){
 const books=tx.objectStore('books'),files=tx.objectStore('files');
 if(limit===0){
  await Promise.all([request(books.clear()),request(files.clear())]);
  return;
 }
 const count=await request(books.count());
 if(count<=limit)return;
 const oldest=await request(books.getAllKeys(undefined,count-limit));
 await Promise.all(oldest.flatMap(id=>[request(books.delete(id)),request(files.delete(id))]));
}

export function listHistory(){
 return transact(['books','settings'],'readonly',async tx=>{
  const [limit,books]=await Promise.all([readLimit(tx),request(tx.objectStore('books').getAll())]);
  return {limit,books:books.reverse()};
 });
}

export function getHistoryFile(id){
 return transact('files','readonly',tx=>request(tx.objectStore('files').get(id)));
}

export function setHistoryLimit(limit){
 if(!Number.isSafeInteger(limit)||limit<0)throw Error('请输入大于或等于 0 的整数');
 return transact(STORE_NAMES,'readwrite',async tx=>{
  await request(tx.objectStore('settings').put(limit,'limit'));
  await trimHistory(tx,limit);
 });
}

export function saveHistoryBook({filename,blob}){
 const finishedAt=Date.now();
 return transact(STORE_NAMES,'readwrite',async tx=>{
  const limit=await readLimit(tx);
  if(limit===0)return;
  const id=await request(tx.objectStore('books').add({filename,finishedAt}));
  await request(tx.objectStore('files').add(blob,id));
  await trimHistory(tx,limit);
 });
}
