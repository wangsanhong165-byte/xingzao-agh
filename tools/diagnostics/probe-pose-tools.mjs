import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPoseTask, getPoseAghStatus } from '../../src/pose-agh.mjs';
import { printAghInternals } from '../../src/print-agh.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const trace=join(root,'data/print-validation',`pose-offline-tools-${randomUUID()}.json`);
const env={...process.env,PHOTO_CAD_OFFLINE_TOOL_PROBE:'1',PHOTO_CAD_OFFLINE_TOOL_PROBE_ROOT:root,PHOTO_CAD_OFFLINE_TOOL_PROBE_TRACE:trace,NODE_OPTIONS:`--import=${pathToFileURL(join(root,'tools/diagnostics/offline-agnes-tools.mjs')).href}`};
const expected = await getPoseAghStatus({env});
const result=await runPoseTask({jobId:`probe-${randomUUID()}`,accessToken:'offline-probe-not-a-real-task-credential',env,task:'Inspect only; this is a network-blocked tool-catalog probe.',spawn:async(...args)=>{try{return await printAghInternals.execFileWithClosedStdin(...args);}catch(error){
  const lines=String(error.stderr??'').split(/\r?\n/).filter(line=>line.trim()&&!/\b(?:apiKey|api_key|accessToken|password|secret)\b/iu.test(line)).slice(0,5);
  console.log(JSON.stringify({errorCode:error.code,errorFields:Object.keys(error),stdoutLength:String(error.stdout??'').length,stderrLength:String(error.stderr??'').length,startupMessages:lines.map(line=>line.replace(/(?:sk-|user_)[A-Za-z0-9_-]+/gu,'[redacted]').slice(0,300))}));throw error;
}}});
let proof;
try{proof=JSON.parse(await readFile(trace,'utf8'));}catch{console.log(JSON.stringify({probe:'failed-before-trace',reason:result.reason,execution:{exitCode:result.execution?.exitCode,turnReason:result.execution?.turnReason,launchDiagnostic:result.execution?.launchDiagnostic}}));process.exitCode=1;}
const required=['pose_inspect','pose_evaluate','pose_select','pose_verify','pose_submit'];
if(proof){if(proof.model!==expected.model||proof.blockedBeforeFetch!==true||required.some(name=>!proof.toolNames.includes(name)))throw new Error('POSE_NATIVE_TOOLS_NOT_OFFERED');
console.log(JSON.stringify({probe:'network-blocked-before-fetch',model:proof.model,requiredToolsOffered:true,toolNames:proof.toolNames,runReason:result.reason,trace}));}
