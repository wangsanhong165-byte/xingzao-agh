import path from 'node:path';
import {existsSync} from 'node:fs';
export function resolveCpuPython(root,{env=process.env,exists=existsSync}={}){
 if(typeof env.PHOTO_CAD_PYTHON==='string'&&env.PHOTO_CAD_PYTHON.trim())return env.PHOTO_CAD_PYTHON;
 const prepared=path.join(root,'data/reconstruction/env-torch-readonly/Scripts/python.exe');
 const legacy=path.join(root,'.venv/Scripts/python.exe');
 return exists(prepared)?prepared:exists(legacy)?legacy:prepared;
}
