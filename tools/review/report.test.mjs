import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReviewerResult,consoleSummary,renderReviewerReport} from './report.mjs';
const fixture=()=>({valid:true,fileCount:25,cases:[{id:'baseline',toolpathFeasible:false,audits:{currentFeatures:{passed:false}},metrics:{}},{id:'normal',toolpathFeasible:true,audits:{currentFeatures:{passed:true}},metrics:{filamentG:.69,estimatedTimeSeconds:557}}],budgetFailure:{actualOptions:[]},claims:{liveModelRequestVerified:false}});
const expected=[{id:'baseline',expectedToolpathFeasible:false},{id:'normal',expectedToolpathFeasible:true}];
test('human report distinguishes an expected failed plan from a failed verification',()=>{
 const result=buildReviewerResult(fixture(),expected);
 assert.equal(result.rows[0].actual,'不可行');assert.equal(result.rows[0].matches,true);
 const text=consoleSummary(result);assert.match(text,/原件直立（0.5 mm）：不可行，符合预期/u);assert.doesNotMatch(text,/false|Claims|infeasible/u);
 assert.match(renderReviewerReport(result),/本次未重新生成模型或打印实物/u);
});
test('mismatched or unknown results cannot be presented as verification passed',()=>{
 const changed=fixture();changed.cases[0].toolpathFeasible=true;
 assert.throws(()=>buildReviewerResult(changed,expected),/与预期不符/u);
 assert.throws(()=>buildReviewerResult(fixture(),[]),/与预期不符/u);
 const html=renderReviewerReport({ok:false,error:'输入 <script> 被替换',checkedAt:new Date().toISOString()});
 assert.match(html,/复核未通过/u);assert.doesNotMatch(html,/<script>/u);assert.match(html,/&lt;script&gt;/u);
});
