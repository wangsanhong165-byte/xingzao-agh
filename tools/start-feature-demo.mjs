import {fixtureFeatureDeclarations} from './critical-feature-fixtures.mjs';
const mode=process.argv[2]??'normal';
const cases={normal:{diameter:.8,candidate:'91926d9e5f4cf56458b6b95070059cbd3fca99a8a20f1dc6c43fe32b8f20280f'},boundary:{diameter:.5,candidate:'8a848e3819d8aeb67d347e1afcbb2e2353671159f0830d92d3b258809bd57736'}};
if(!cases[mode])throw new Error('FEATURE_DEMO_MODE_INVALID');
const item=cases[mode];
const response=await fetch('http://127.0.0.1:4337/api/poses/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sourceKind:'imported',sourceCandidateId:item.candidate,criticalFeatures:fixtureFeatureDeclarations(item.diameter),featureSource:'demonstration-coordinate-bounds',protectedRegions:[],maxRegionSupportPathLengthMm:null})});
const result=await response.json();if(response.status!==202)throw new Error(result.error??'FEATURE_DEMO_START_FAILED');
console.log(JSON.stringify({mode,sourceKind:'imported',pinDiameterMm:item.diameter,...result}));
