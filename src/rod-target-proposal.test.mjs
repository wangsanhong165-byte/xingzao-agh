import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeProposalInput} from './rod-target-proposal.mjs';
test('readonly fitting rejects invalid points and out-of-contract user budgets',()=>{
 const input={pointInPrintMm:[1,2,3],axis:'z',maxRadialGrowthMm:.2,maxAddedVolumeMm3:20};
 assert.deepEqual(normalizeProposalInput(input),input);
 for(const patch of [{pointInPrintMm:[1,NaN,3]},{pointInPrintMm:[1001,0,0]},{axis:'diagonal'},{maxRadialGrowthMm:0},{maxRadialGrowthMm:true},{maxRadialGrowthMm:1.1},{maxAddedVolumeMm3:Infinity},{maxAddedVolumeMm3:10001}])assert.throws(()=>normalizeProposalInput({...input,...patch}),/REPAIR_/);
 const parsed=normalizeProposalInput(input);parsed.pointInPrintMm[0]=5;assert.equal(input.pointInPrintMm[0],1);
});
