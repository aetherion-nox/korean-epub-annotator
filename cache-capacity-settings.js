import {CACHE_LIMIT_SETTING,normalizeAnnotationCacheLimit} from './session-cache.js';
export function bindCacheCapacity(doc=document,storage=chrome.storage){
 const input=doc.getElementById('annotationCacheLimit'),clear=doc.getElementById('clearCacheOnExit');
 if(!input||!clear)return;
 storage.local.get([CACHE_LIMIT_SETTING,'uiSettings']).then(s=>{input.value=String(normalizeAnnotationCacheLimit(s[CACHE_LIMIT_SETTING]));clear.checked=s.uiSettings?.clearCacheOnExit===true;}).catch(console.error);
 input.addEventListener('change',()=>{const value=normalizeAnnotationCacheLimit(Number(input.value));input.value=String(value);storage.local.set({[CACHE_LIMIT_SETTING]:value}).catch(console.error);});
 clear.addEventListener('change',async()=>{const {uiSettings={}}=await storage.local.get('uiSettings');await storage.local.set({uiSettings:{...uiSettings,clearCacheOnExit:clear.checked}});});
}
