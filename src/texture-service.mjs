import {access,readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runOwnedTextureProcess} from './texture-owned-process.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const python=path.join(root,'data/reconstruction/env-texture-probe/Scripts/python.exe');
const worker=path.join(root,'tools/reconstruction/texture_worker.py');
const invoke=promisify(execFile);
const exists=file=>access(file).then(()=>true,()=>false);

async function runtime(){
 const configuration=await readFile(path.join(path.dirname(path.dirname(python)),'pyvenv.cfg'),'utf8');
 const configuredHome=configuration.match(/^home\s*=\s*(.+)$/mu)?.[1]?.trim();
 if(!configuredHome||!path.isAbsolute(configuredHome))throw new Error('TEXTURE_RUNTIME_INVALID');
 const executable=path.join(configuredHome,'python.exe'),stat=await lstat(executable);
 if(!stat.isFile()||stat.isSymbolicLink())throw new Error('TEXTURE_RUNTIME_INVALID');
 // Invoke the actual executable with CPython's own venv launcher value.
 // On Windows this preserves the isolated prefix without an intermediate
 // redirector process, so execFile timeout owns the process running CUDA.
 return {executable,launcher:python};
}
function parseWorker(text){
 try{const parsed=JSON.parse(text.trim());if(parsed?.success===true&&parsed.code==='OK')return parsed;if(parsed?.success===false&&['TEXTURE_GPU_BUSY','TEXTURE_RESOURCE_FAILURE','TEXTURE_ENGINE_FAILURE','TEXTURE_SOURCE_CHANGED','TEXTURE_RESULT_INVALID','TEXTURE_INPUT_INVALID'].includes(parsed.code))return {success:false,code:parsed.code};}catch{}
 return {success:false,code:'TEXTURE_ENGINE_FAILURE'};
}

export async function getTextureEngineStatus(){
 const files=[python,worker,path.join(root,'tools/reconstruction/run_texture_probe.py'),path.join(root,'tools/reconstruction/texture_source_manifest.json'),path.join(root,'tools/reconstruction/texture_model_manifest.json'),path.join(root,'data/reconstruction/modelcache/hunyuan3d-paint-probe/hunyuan3d-paint-v2-0-turbo/unet/diffusion_pytorch_model.bin')];
 return {available:(await Promise.all(files.map(exists))).every(Boolean),scope:'flat-illustration-existing-stl'};
}
export async function runTextureWorker(request,{spawn=runOwnedTextureProcess,signal}={}){
 const directory=path.resolve(request.outputDir),data=path.join(root,'data'),relative=path.relative(data,directory);
 if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))return {success:false,code:'TEXTURE_INPUT_INVALID'};
 try{
  const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||path.resolve(await realpath(directory))!==directory)return {success:false,code:'TEXTURE_INPUT_INVALID'};
  const requestFile=path.join(directory,`request-${request.mode}-${randomUUID()}.json`);await writeFile(requestFile,JSON.stringify(request),{flag:'wx'});
  const env=Object.fromEntries(['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','CUDA_VISIBLE_DEVICES'].filter(k=>typeof process.env[k]==='string').map(k=>[k,process.env[k]]));
  const selected=await runtime();env.__PYVENV_LAUNCHER__=selected.launcher;
  const result=await spawn(selected.executable,['-X','utf8',worker,'--owned-start','--request',requestFile],{cwd:root,env,windowsHide:true,shell:false,timeout:735000,maxBuffer:64*1024,encoding:'utf8',...(signal?{signal}: {})});
  return parseWorker(result.stdout);
 }catch(error){return typeof error?.stdout==='string'?parseWorker(error.stdout):{success:false,code:'TEXTURE_ENGINE_FAILURE'};}
}
