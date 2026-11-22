import {copyFileSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
const source=join(process.cwd(),'node_modules','fflate','esm','browser.js');
const target=join(process.cwd(),'epub-fflate.js');
if(!existsSync(source)||statSync(source).size<1000)
 throw new Error('fflate 0.8.2 ESM browser build not installed; run npm install');
copyFileSync(source,target);
console.log('Packaged pinned fflate browser ESM at '+target);
