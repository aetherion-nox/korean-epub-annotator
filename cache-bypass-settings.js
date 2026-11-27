// Temporary bypass belongs to the browser session; persistent bypass is independent.
export async function readCacheBypass(storage){
 const [session,local]=await Promise.all([storage.session?.get('sessionForceRegenerate')??{},storage.local.get('persistentForceRegenerate')]);
 return {temporary:session?.sessionForceRegenerate===true,persistent:local?.persistentForceRegenerate===true};
}
export function bindCacheBypassControls(doc=document,storage=chrome.storage,onError=console.error){
 const temporary=doc.getElementById('forceRegenerate'),persistent=doc.getElementById('persistentForceRegenerate'),row=doc.getElementById('persistentForceRow');
 let queue=Promise.resolve(),state={temporary:false,persistent:false};
 const render=()=>{if(!temporary||!persistent||!row)return;
  temporary.checked=state.temporary;persistent.checked=state.persistent;
  temporary.disabled=state.persistent;row.hidden=!(state.temporary||state.persistent);
 };
 const reload=async()=>{state=await readCacheBypass(storage);render();};
 const enqueue=fn=>{queue=queue.catch(()=>{}).then(fn);queue.catch(onError);return queue;};
 if(temporary&&persistent&&row){
  temporary.disabled=true;persistent.disabled=true;
  enqueue(async()=>{await reload();persistent.disabled=false;});
  temporary.addEventListener('change',()=>{const value=temporary.checked;enqueue(async()=>{await storage.session.set({sessionForceRegenerate:value});await reload();});});
  persistent.addEventListener('change',()=>{const value=persistent.checked;enqueue(async()=>{await storage.local.set({persistentForceRegenerate:value});await reload();});});
  storage.onChanged?.addListener((changes,area)=>{
   if(area==='session'&&changes.sessionForceRegenerate||area==='local'&&changes.persistentForceRegenerate)enqueue(reload);
  });
 }
 return {async snapshot(){await queue;const values=await readCacheBypass(storage);return values.temporary||values.persistent;}};
}
