/** Independent software sensitivity baseline. Does not modify production profiles. */
export function buildArachneSensitivityProfile(original,minBeadWidthPercent){
 if(typeof original!=='string'||![60,75].includes(minBeadWidthPercent))throw Error('BASELINE_SENSITIVITY_INVALID');
 const read=key=>{
  const matches=[...original.matchAll(new RegExp(`^${key}[ \\t]*=[ \\t]*([^\\r\\n]*)`,'gmu'))];
  if(matches.length!==1)throw Error('BASELINE_PROFILE_AMBIGUOUS');
  return matches[0][1].trim();
 };
 if(read('perimeter_generator')!=='arachne')throw Error('ARACHNE_BASELINE_REQUIRED');
 const changes={min_bead_width:{from:read('min_bead_width'),to:`${minBeadWidthPercent}%`},min_feature_size:{from:read('min_feature_size'),to:'10%'}};
 let text=original;
 for(const [key,change] of Object.entries(changes))text=text.replace(new RegExp(`^${key}([ \\t]*=[ \\t]*)[^\\r\\n]*`,'mu'),(_whole,separator)=>`${key}${separator}${change.to}`);
 return {text,changes,scope:'virtual-slicer-bead-width-sensitivity-not-physical-calibration'};
}
