import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PNG} from 'pngjs';
import {createHash} from 'node:crypto';

const read=name=>PNG.sync.read(readFileSync(new URL('../icons/'+name,import.meta.url)));
test('EPUB Chrome icon sizes are generated from dedicated book artwork',()=>{
 const source=read('epub-icon-source.png');
 assert.equal(source.width,128);
 assert.equal(source.height,128);
 const variants=[16,32,48,128].map(size=>{
  const png=read('icon'+size+'.png');
  assert.equal(png.width,size);
  assert.equal(png.height,size);
  assert.equal(png.data.length,size*size*4);
  assert.ok(png.data.some((v,i)=>i%4===3&&v>0),'icon must not be empty');
  return {size,hash:createHash('sha256').update(png.data).digest('hex')};
 });
 assert.equal(new Set(variants.map(x=>x.hash)).size,4,'distinct image sizes, not one copied file');
 const base=readFileSync(new URL('../manifest.json',import.meta.url));
 const manifest=JSON.parse(base);
 assert.equal(manifest.version,'1.0.1');
 for(const [size,path] of Object.entries(manifest.icons))
  assert.equal(path,'icons/icon'+size+'.png');
 assert.equal(manifest.action.default_icon['16'],'icons/icon16.png');
 assert.equal(manifest.action.default_icon['32'],'icons/icon32.png');
 const html=readFileSync(new URL('../epub.html',import.meta.url),'utf8');
 assert.match(html,/src="icons\/icon128\.png"/);
});
