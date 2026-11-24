import {APPEARANCE_KEY,DEFAULT_APPEARANCE,normalizeAnnotationAppearance,applyAnnotationAppearance} from './annotation-appearance.js';
const el=id=>document.getElementById(id),size=el('annotationSize'),opacity=el('annotationOpacity');
const current=()=>normalizeAnnotationAppearance({size:Number(size.value),opacity:Number(opacity.value)});
function render(value){const a=normalizeAnnotationAppearance(value);size.value=a.size;opacity.value=a.opacity;el('annotationSizeValue').textContent=a.size+'%';el('annotationOpacityValue').textContent=a.opacity+'%';applyAnnotationAppearance(el('annotationAppearancePreview'),a);}
let queue=Promise.resolve();
function save(){const a=current();render(a);queue=queue.catch(()=>{}).then(()=>chrome.storage.local.set({[APPEARANCE_KEY]:a})).then(()=>{el('annotationAppearanceStatus').textContent='已保存，应用于之后生成的 EPUB。';}).catch(e=>{el('annotationAppearanceStatus').textContent=e.message;});}
for(const input of [size,opacity]){input.addEventListener('input',()=>render(current()));input.addEventListener('change',save);}
el('resetAnnotationAppearance').addEventListener('click',()=>{render(DEFAULT_APPEARANCE);save();});
chrome.storage.local.get(APPEARANCE_KEY).then(data=>render(data[APPEARANCE_KEY])).catch(e=>{el('annotationAppearanceStatus').textContent=e.message;});
