import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {getHistoryFile,listHistory,saveHistoryBook,setHistoryLimit} from '../epub-history.js';

const freshHistory=()=>{globalThis.indexedDB=new IDBFactory();};
const book=n=>({filename:`${n}-annotated.epub`,blob:new Blob([String(n)],{type:'application/epub+zip'})});

test('history retains the latest ten outputs and retrieves the exact EPUB bytes',async()=>{
 freshHistory();
 assert.deepEqual(await listHistory(),{limit:10,books:[]});
 await saveHistoryBook(book(0));
 const [oldest]=(await listHistory()).books;
 for(let n=1;n<=11;n++)await saveHistoryBook(book(n));
 const {limit,books}=await listHistory();
 assert.equal(limit,10);
 assert.deepEqual(books.map(entry=>entry.filename),Array.from({length:10},(_,i)=>book(11-i).filename));
 assert.equal(await getHistoryFile(oldest.id),undefined);
 assert.ok(books.every(entry=>typeof entry.finishedAt==='number'&&!Object.hasOwn(entry,'blob')));
 const saved=await getHistoryFile(books[0].id);
 assert.equal(saved.type,'application/epub+zip');
 assert.deepEqual(await saved.arrayBuffer(),await book(11).blob.arrayBuffer());
});

test('retention changes prune both records and files and zero prevents concurrent saves',async()=>{
 freshHistory();
 await setHistoryLimit(12);
 for(let n=0;n<12;n++)await saveHistoryBook(book(n));
 const old=(await listHistory()).books;
 assert.equal(old.length,12);
 await setHistoryLimit(1);
 assert.deepEqual(await listHistory(),{limit:1,books:[old[0]]});
 assert.equal(await getHistoryFile(old[1].id),undefined);
 await Promise.all([setHistoryLimit(0),saveHistoryBook(book(12))]);
 assert.deepEqual(await listHistory(),{limit:0,books:[]});
 assert.equal(await getHistoryFile(old[0].id),undefined);
 await saveHistoryBook(book(13));
 await setHistoryLimit(2);
 assert.deepEqual(await listHistory(),{limit:2,books:[]});
 await saveHistoryBook(book(14));
 assert.deepEqual((await listHistory()).books.map(entry=>entry.filename),[book(14).filename]);
 for(const invalid of [-1,1.5,NaN,'3',Number.MAX_SAFE_INTEGER+1]){
  assert.throws(()=>setHistoryLimit(invalid),/整数/);
 }
});

test('a failed payload write leaves existing history intact and creates no orphan record',async()=>{
 freshHistory();
 await setHistoryLimit(1);
 await saveHistoryBook(book(1));
 const before=await listHistory();
 await assert.rejects(saveHistoryBook({filename:'bad.epub',blob:()=>{}}),{name:'DataCloneError'});
 assert.deepEqual(await listHistory(),before);
 assert.equal(await (await getHistoryFile(before.books[0].id)).text(),'1');
});
