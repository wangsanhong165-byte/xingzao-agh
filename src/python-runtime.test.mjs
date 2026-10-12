import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {resolveCpuPython} from './python-runtime.mjs';
test('image tools use the environment created by the reproduction installer',()=>{
 const root=path.resolve('fixture-root'),prepared=path.join(root,'data/reconstruction/env-torch-readonly/Scripts/python.exe');
 assert.equal(resolveCpuPython(root,{env:{},exists:p=>p===prepared}),prepared);
});
test('an explicit interpreter is retained and a legacy environment is a fallback',()=>{
 const root=path.resolve('fixture-root'),legacy=path.join(root,'.venv/Scripts/python.exe');
 assert.equal(resolveCpuPython(root,{env:{PHOTO_CAD_PYTHON:'explicit-python'},exists:()=>false}),'explicit-python');
 assert.equal(resolveCpuPython(root,{env:{},exists:p=>p===legacy}),legacy);
});
