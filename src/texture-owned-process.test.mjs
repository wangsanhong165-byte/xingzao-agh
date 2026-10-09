import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runOwnedTextureProcess} from './texture-owned-process.mjs';

test('ownership is assigned before releasing the worker and closed on completion',async()=>{
 const events=[];let callback;
 const api={createWindowsProcessJob:()=>({assign:(pid,start)=>{assert.equal(pid,123);assert.equal(start,'creation');events.push('assign');},close:()=>events.push('close')}),windowsProcessStartTimeSync:()=> 'creation'};
 const exec=(_file,_args,_options,done)=>{callback=done;const child=new EventEmitter();child.pid=123;child.stdin={end:text=>{assert.equal(text,'TEXTURE_START\n');events.push('start');queueMicrotask(()=>callback(null,'JSON'));}};queueMicrotask(()=>child.emit('spawn'));return child;};
 assert.equal((await runOwnedTextureProcess('owned',[],{},{api,exec})).stdout,'JSON');assert.deepEqual(events,['assign','start','close']);
});
test('failed ownership never releases the worker to business execution',async()=>{
 let started=false,killed=false;
 const api={createWindowsProcessJob:()=>({assign:()=>{throw new Error('cannot own');},close:()=>{}}),windowsProcessStartTimeSync:()=> 'creation'};
 const exec=()=>{const child=new EventEmitter();child.pid=123;child.stdin={end:()=>{started=true;}};child.kill=()=>{killed=true;};queueMicrotask(()=>child.emit('spawn'));return child;};
 await assert.rejects(runOwnedTextureProcess('owned',[],{},{api,exec}),/cannot own/);assert.equal(started,false);assert.equal(killed,true);
});
