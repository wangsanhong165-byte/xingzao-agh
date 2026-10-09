import test from 'node:test';
import assert from 'node:assert/strict';
import {RepairJobStore} from './repair-jobs.mjs';
const sha='a'.repeat(64);
function setup(check){
 const store=new RepairJobStore({persist:false,verifyCandidate:check});
 store.assertPolicy=async()=>{};store.assertCandidate=()=>{};
 let reads=0;store.readStl=async()=>{reads++;return Buffer.from('verified fixture');};
 const candidate={candidateId:'r02',feasible:true,result:{poseProof:{candidateSha256:sha}}};
 const job={stage:'completed',submittedCandidateId:'r02',recheck:{verified:true},candidates:{r02:candidate}};
 return {store,job,reads:()=>reads};
}
test('delivery repeats verification and rejects a historical sampled pass with a real rod gap',async()=>{
 const {store,job,reads}=setup(async()=>({verified:false,reason:'ROD_TOOLPATH_DISCONNECTED'}));
 await assert.rejects(async()=>store.readDeliveryStl(job,'r02',sha),/ROD_TOOLPATH_DISCONNECTED/u);
 assert.equal(reads(),0);
});
test('verified delivery requires the submitted candidate, matching SHA and a fresh matching check',async()=>{
 let checks=0;
 const {store,job,reads}=setup(async()=>{checks++;return {verified:true,candidateSha256:sha};});
 await assert.rejects(async()=>store.readDeliveryStl(job,'r01',sha),/REPAIR_DELIVERY_REQUIRED/u);
 await assert.rejects(async()=>store.readDeliveryStl(job,'r02','b'.repeat(64)),/REPAIR_STALE_SHA/u);
 assert.equal(checks,0);
 assert.equal((await store.readDeliveryStl(job,'r02',sha)).toString(),'verified fixture');
 assert.equal(checks,1);assert.equal(reads(),1);
 job.stage='no-feasible';await assert.rejects(async()=>store.readDeliveryStl(job,'r02',sha),/REPAIR_DELIVERY_REQUIRED/u);
});
