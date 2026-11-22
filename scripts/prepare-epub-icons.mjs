import {readFileSync,writeFileSync} from 'node:fs';
import {PNG} from 'pngjs';

const source=PNG.sync.read(readFileSync(new URL('../icons/epub-icon-source.png',import.meta.url)));
if(source.width!==128||source.height!==128)throw Error('The EPUB book icon source must be 128×128');
function resize(target){
 const out=new PNG({width:target,height:target,colorType:6,inputColorType:6});
 const ratio=source.width/target;
 for(let y=0;y<target;y++)for(let x=0;x<target;x++){
  let rgba=[0,0,0],sumAlpha=0,sumArea=0;
  const x0=x*ratio,x1=(x+1)*ratio,y0=y*ratio,y1=(y+1)*ratio;
  for(let sy=Math.floor(y0);sy<Math.ceil(y1);sy++){
   const wy=Math.max(0,Math.min(y1,sy+1)-Math.max(y0,sy));
   for(let sx=Math.floor(x0);sx<Math.ceil(x1);sx++){
    const wx=Math.max(0,Math.min(x1,sx+1)-Math.max(x0,sx));
    const weight=wx*wy,offset=(sy*source.width+sx)*4;
    const alpha=source.data[offset+3]/255;
    for(let c=0;c<3;c++)rgba[c]+=source.data[offset+c]*alpha*weight;
    sumAlpha+=alpha*weight;sumArea+=weight;
   }
  }
  const offset=(y*target+x)*4;
  for(let c=0;c<3;c++)out.data[offset+c]=sumAlpha>0?Math.round(rgba[c]/sumAlpha):0;
  out.data[offset+3]=Math.round(255*sumAlpha/sumArea);
 }
 return PNG.sync.write(out,{colorType:6,deflateLevel:9});
}
for(const size of [16,32,48,128]){
 const output=new URL('../icons/icon'+size+'.png',import.meta.url);
 const bytes=resize(size);
 writeFileSync(output,bytes);
 console.log('EPUB icon',size+'×'+size,bytes.length,'bytes');
}
