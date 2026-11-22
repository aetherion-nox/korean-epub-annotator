import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireEpubApiSlot,activeEpubApiRequests} from '../epub-api-concurrency.js';

test('book semaphore permits exactly the selected count across independent callers',async()=>{
 const run={epubBookSession:true,epubBookRunId:'same-book',epubApiConcurrency:2};
 const r1=await acquireEpubApiSlot(run);
 const r2=await acquireEpubApiSlot(run);
 assert.equal(activeEpubApiRequests('same-book'),2);
 let third=false;
 const queued=acquireEpubApiSlot(run).then(release=>{third=true;return release;});
 await Promise.resolve();
 assert.equal(third,false);
 r1();
 const r3=await queued;
 assert.equal(third,true);
 assert.equal(activeEpubApiRequests('same-book'),2);
 r2();r3();
 assert.equal(activeEpubApiRequests('same-book'),0);
 r3(); // no double-release
 assert.equal(activeEpubApiRequests('same-book'),0);
});

test('different EPUB books never share capacity; webpage requests skip EPUB semaphore',async()=>{
 const a={epubBookSession:true,epubBookRunId:'book-A',epubApiConcurrency:1};
 const b={epubBookSession:true,epubBookRunId:'book-B',epubApiConcurrency:1};
 const ra=await acquireEpubApiSlot(a),rb=await acquireEpubApiSlot(b);
 const web=await acquireEpubApiSlot({...a,epubBookSession:false});
 assert.equal(activeEpubApiRequests('book-A'),1);
 assert.equal(activeEpubApiRequests('book-B'),1);
 web();ra();rb();
 assert.equal(activeEpubApiRequests('book-A'),0);
});

test('canceled queued requests disappear and cannot steal the next book slot',async()=>{
 const c={epubBookSession:true,epubBookRunId:'cancel-book',epubApiConcurrency:1};
 const release=await acquireEpubApiSlot(c);
 const abort=new AbortController();
 const waiting=acquireEpubApiSlot(c,abort.signal);
 abort.abort();
 await assert.rejects(waiting);
 release();
 const next=await acquireEpubApiSlot(c);
 assert.equal(activeEpubApiRequests('cancel-book'),1);
 next();
});
