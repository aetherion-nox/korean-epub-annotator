// Book-session history of *validator-rejected* model choices.
// A model's source-relative t and a request's pooled p IDs are ephemeral;
// use immutable sentence/source geometry for stable cross-batch feedback.
const MAX_CHOICES_PER_MODEL=16;
const MAX_FEEDBACK_PER_TARGET=16;
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);

export function epubRejectedSourceKey(target){
 return JSON.stringify([
  target.source_sentence_id||target.repair_sentence_key||target.context||'',
  target.original_target_id||target.target_id,target.start,target.end,target.surface
 ]);
}

export function epubRejectedModelKey(config,target){
 return JSON.stringify([
  config.provider||'',config.model||'',config.endpoint||'',
  ...JSON.parse(epubRejectedSourceKey(target))
 ]);
}

export function epubRejectedReason(target,choice,config={},reportedSamples=[]){
 const sample=reportedSamples.find(row=>
  row?.target_id===target.target_id&&row?.c===choice);
 if(sample&&typeof sample.reason==='string'&&sample.reason)return sample.reason;
 if(typeof choice==='string'&&/^p\d+$/u.test(choice))return 'invalid_pooled_choice_id';
 if(typeof choice==='string'&&/^[cn]\d+$/u.test(choice)){
  // A local c/n key is not a portable pooled p key. The EPUB-specific
  // checker can distinguish a nonexistent option from a POS-excluded one.
  return config.epubInvalidChoiceReason?.(target,choice,config)||'invalid_choice_id';
 }
 return config.explainLiteralOriginRejection?.(target,choice,config)||
  'invalid_choice_or_origin';
}

function normalizedCount(entry){
 return typeof entry==='number'?entry:isObject(entry)?Number(entry.count)||0:0;
}
function normalizedReason(entry){
 return isObject(entry)&&typeof entry.reason==='string'&&entry.reason?
  entry.reason:'previously_rejected';
}

export function recordEpubRejectedChoice(history,config,target,choice,reason){
 if(!(history instanceof Map)||typeof choice!=='string'||!choice||
    typeof reason!=='string'||!reason)return null;
 const key=epubRejectedModelKey(config,target);
 const prior=history.get(key);
 const counts={...(isObject(prior?.counts)?prior.counts:{})};
 const old=counts[choice];
 counts[choice]={
  count:Math.min(100,normalizedCount(old)+1),
  reason:reason.slice(0,100)
 };
 while(Object.keys(counts).length>MAX_CHOICES_PER_MODEL)
  delete counts[Object.keys(counts)[0]];
 const record={counts,last:choice};
 history.set(key,record);
 return {key,record};
}

export function epubRejectedChoicesForTarget(history,target){
 if(!(history instanceof Map))return [];
 const source=epubRejectedSourceKey(target);
 const combined=new Map();
 for(const [key,record] of history){
  let parts;
  try{parts=JSON.parse(key);}
  catch{continue;}
  if(!Array.isArray(parts)||parts.length!==8||
     JSON.stringify(parts.slice(3))!==source||!isObject(record?.counts))continue;
  for(const [c,entry] of Object.entries(record.counts)){
   if(!c)continue;
   const reason=normalizedReason(entry);
   const old=combined.get(c);
   if(old&&old.reason!=='previously_rejected'&&reason==='previously_rejected')continue;
   combined.set(c,{c,reason,
    ...(/^p\d+$/u.test(c)?{scope:'previous_request_only'}:{})});
  }
 }
 return [...combined.values()].slice(-MAX_FEEDBACK_PER_TARGET);
}

export function epubRepeatedInvalidChoice(history,config,target){
 const record=history instanceof Map?history.get(epubRejectedModelKey(config,target)):null;
 return Object.entries(isObject(record?.counts)?record.counts:{}).some(([choice,entry])=>
  // p IDs can be rebound to different candidates when resubmitting a
  // smaller batch, so their repetition is never a global stop condition.
  !/^p\d+$/u.test(choice)&&normalizedCount(entry)>=2);
}
