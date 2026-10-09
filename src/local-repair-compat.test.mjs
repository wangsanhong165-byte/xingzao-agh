import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {repairServiceInternals} from './local-repair-service.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
test('historical and new geometry receipts select their own known verifier bytes',async()=>{
 assert.equal(typeof repairServiceInternals.geometryHelperForReceipt,'function');
 const legacy=new URL('../tools/reconstruction/local_rod_repair.py',import.meta.url);
 const current=new URL('../tools/reconstruction/local_rod_repair_v2.py',import.meta.url);
 const oldSha=sha(await readFile(legacy)),newSha=sha(await readFile(current));
 assert.notEqual(oldSha,newSha);
 const old=await repairServiceInternals.geometryHelperForReceipt(oldSha);
 const next=await repairServiceInternals.geometryHelperForReceipt(newSha);
 assert.equal(old.sha256,oldSha);assert.match(old.path,/local_rod_repair\.py$/);
 assert.equal(next.sha256,newSha);assert.match(next.path,/local_rod_repair_v2\.py$/);
 assert.equal((await repairServiceInternals.geometryHelperForReceipt()).sha256,newSha);
});
test('unrecognized verifier fingerprints cannot pick a different file or silently upgrade',async()=>{
 assert.equal(typeof repairServiceInternals.geometryHelperForReceipt,'function');
 await assert.rejects(repairServiceInternals.geometryHelperForReceipt('0'.repeat(64)),/REPAIR_GEOMETRY_RECEIPT_CHANGED/);
 await assert.rejects(repairServiceInternals.geometryHelperForReceipt('../../anything'),/REPAIR_GEOMETRY_RECEIPT_CHANGED/);
});
