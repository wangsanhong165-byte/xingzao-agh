import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRepairSpec,repairRadiusOptions,repairServiceInternals} from './local-repair-service.mjs';

const spec={axis:'z',centerLineMm:[[5,0,3],[5,0,5]],allowedBoundsMm:[[4.5,-.5,3],[5.5,.5,5]],maxRadialGrowthMm:.2,maxAddedVolumeMm3:2};
test('normalizes an explicit bounded rod repair and does not alias caller data',()=>{
  const s=normalizeRepairSpec(spec);assert.deepEqual(s,spec);s.centerLineMm[0][0]=9;assert.equal(spec.centerLineMm[0][0],5);
});
test('rejects diagonal axis, inverted scope, booleans and unbounded budgets',()=>{
  for(const change of [{axis:'q'},{centerLineMm:[[5,0,3],[6,0,5]]},{centerLineMm:[[5,0,5],[5,0,3]]},{allowedBoundsMm:[[6,-.5,3],[5.5,.5,5]]},{maxRadialGrowthMm:true},{maxRadialGrowthMm:2},{maxAddedVolumeMm3:0}])assert.throws(()=>normalizeRepairSpec({...spec,...change}),/REPAIR_/);
});
test('offers finite nozzle-relative candidates only when they fit the growth budget',()=>{
  assert.deepEqual(repairRadiusOptions({measuredRadiusMm:.25,fitToleranceMm:.001},spec,.4),[.3,.35,.4]);
  assert.deepEqual(repairRadiusOptions({measuredRadiusMm:.25,fitToleranceMm:.001},{...spec,maxRadialGrowthMm:.02},.4),[]);
  assert.throws(()=>repairRadiusOptions({measuredRadiusMm:NaN},spec,.4),/REPAIR_/);
});

test('receipt binding rejects a changed requested radius even if its own params hash was recomputed',()=>{
  const geometry={mode:'apply',sourceSha256:'a'.repeat(64),candidateSha256:'b'.repeat(64),helperSha256:'c'.repeat(64),spec,radiusMm:.4};
  const receipt={...geometry,geometry};
  assert.doesNotThrow(()=>repairServiceInternals.assertReceiptBinding(receipt));
  assert.throws(()=>repairServiceInternals.assertReceiptBinding({...receipt,radiusMm:.3}),/REPAIR_GEOMETRY_RECEIPT_CHANGED/);
  assert.throws(()=>repairServiceInternals.assertReceiptBinding({...receipt,candidateSha256:'d'.repeat(64)}),/REPAIR_GEOMETRY_RECEIPT_CHANGED/);
});
