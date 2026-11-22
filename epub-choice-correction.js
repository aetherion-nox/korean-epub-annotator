import {filterReviewTarget} from './review-pos.js';

// EPUB correction prompts preserve all target-legal dictionary keys after the
// existing POS filter. The optional Hanja reading checker cannot veto them.
export function epubSafeCorrectionTarget(target,config={}){
 return filterReviewTarget(target,config);
}

export function epubInvalidChoiceReason(target,choice,config={}){
 if(typeof choice!=='string'||!/^[cn]\d+$/u.test(choice))
  return 'non_numbered_or_malformed';
 const raw=target.options?.find(o=>o.type!=='keep'&&o.choice_id===choice);
 if(!raw)return 'choice_not_in_target_options';
 const shown=filterReviewTarget(target,config).options;
 if(!shown.some(o=>o.type!=='keep'&&o.choice_id===choice))
  return 'choice_filtered_by_pos';
 return 'choice_other_validation_failure';
}
