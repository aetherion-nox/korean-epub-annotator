// Page-side recovery for an interrupted manual-review stream. Never trust
// batch IDs alone: replay only when the complete target/candidate context
// is identical after removing the randomized batch ID.
export function manualPromptPayload(text){
 if(typeof text!=='string')return null;
 const marker='{"format":"shared-pools-v5"';
 const index=text.indexOf(marker);
 if(index<0)return null;
 try{
  const payload=JSON.parse(text.slice(index));
  if(payload?.format!=='shared-pools-v5'||!Array.isArray(payload.targets)||
     !Array.isArray(payload.sentences)||!Array.isArray(payload.candidates))return null;
  return payload;
 }catch{return null;}
}
export function manualRequestIdentity(request){
 if(!request?.text||!request?.requestId)return null;
 const payload=manualPromptPayload(request.text);
 if(!payload)return null;
 delete payload.batch_id;
 return JSON.stringify(payload);
}
export function sameManualTargets(before,after){
 const a=manualRequestIdentity(before),b=manualRequestIdentity(after);
 return Boolean(a&&b&&a===b);
}
function extractAnswer(text){
 if(typeof text!=='string'||!text.trim())return null;
 let source=text.trim();
 const fence=/^\x60{3}(?:json)?\s*\n?([\s\S]*?)\n?\x60{3}$/iu.exec(source);
 if(fence)source=fence[1].trim();
 try{
  const value=JSON.parse(source);
  return Array.isArray(value)?{results:value}:value&&typeof value==='object'?value:null;
 }catch{return null;}
}
export function transferManualAnswer(text,oldRequest,newRequest,acceptedRows=[]){
 if(!sameManualTargets(oldRequest,newRequest))return null;
 const parsed=extractAnswer(text);
 if(!parsed||!Array.isArray(parsed.results)||(
   Object.hasOwn(parsed,'batch_id')&&parsed.batch_id!==oldRequest.requestId
 ))return null;
 const chosen=new Map();
 for(const row of acceptedRows)if(row&&typeof row.t==='string')chosen.set(row.t,row);
 for(const row of parsed.results)if(row&&typeof row.t==='string')chosen.set(row.t,row);
 return JSON.stringify({...parsed,batch_id:newRequest.requestId,results:[...chosen.values()]});
}
