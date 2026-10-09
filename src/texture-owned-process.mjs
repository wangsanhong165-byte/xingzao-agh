import {execFile} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
let nativePromise;
async function nativeProcessApi(){
 nativePromise??=(async()=>{const source=path.join(root,'data/agh-source');await import(pathToFileURL(path.join(source,'node_modules/tsx/dist/loader.mjs')).href);return import(pathToFileURL(path.join(source,'packages/system-node/src/index.ts')).href);})();
 return nativePromise;
}

/** The child waits for stdin ownership confirmation before any model work. */
export async function runOwnedTextureProcess(file,args,options,{api,exec=execFile}={}){
 const native=api??await nativeProcessApi();
 const job=native.createWindowsProcessJob();
 return new Promise((resolve,reject)=>{
  let child,settled=false;
  const finish=(error,stdout='',stderr='')=>{
   if(settled)return;settled=true;
   try{job.close();}catch{}
   if(error){error.stdout??=stdout;error.stderr??=stderr;reject(error);}else resolve({stdout,stderr,code:0});
  };
  try{
   child=exec(file,args,options,finish);
   child.once('spawn',()=>{
    if(settled)return;
    try{const start=native.windowsProcessStartTimeSync(child.pid);if(!start)throw new Error('TEXTURE_PROCESS_EXITED');job.assign(child.pid,start);child.stdin.end('TEXTURE_START\n');}
    catch(error){try{job.close();child.kill();}catch{}finish(error);}
   });
  }catch(error){finish(error);}
 });
}
