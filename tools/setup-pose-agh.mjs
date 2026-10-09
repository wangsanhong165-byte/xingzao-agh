import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { printAghInternals } from '../src/print-agh.mjs';
import { createRequire } from 'node:module';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sourceRoot=join(root,'data/agh-source');
const home=printAghInternals.reconstructionHome(process.env);
const profileDir=join(home,'profiles/local-dev');
const packageId='@photo-cad/pose-tools';
const require=createRequire(join(sourceRoot,'packages/package-manager/package.json'));
const yaml=require('yaml');
await import(pathToFileURL(join(sourceRoot,'node_modules/tsx/dist/loader.mjs')).href);
const {createPackageManager}=await import(pathToFileURL(join(sourceRoot,'packages/package-manager/src/manager.ts')).href);
const {parseSource}=await import(pathToFileURL(join(sourceRoot,'packages/package-manager/src/sources.ts')).href);
const {capabilityHash}=await import(pathToFileURL(join(sourceRoot,'packages/package-manager/src/integrity.ts')).href);
const {activeRuntimePinId}=await import(pathToFileURL(join(sourceRoot,'packages/package-manager/src/package-plugin-loader.ts')).href);
const lock=JSON.parse(await readFile(join(profileDir,'agnes-lock.json'),'utf8'));
const manager=createPackageManager({dataDir:join(home,'data'),agnesVersion:lock.generatedBy.agnesVersion,cwd:root});
const source=parseSource('file:./pose-agh-plugin');
const preview=await manager.inspect(profileDir,source);
console.log(JSON.stringify({id:preview.id,version:preview.version,integrity:preview.integrity,capabilityHash:preview.capabilityHash,blockers:preview.blockers,mode:'official-package-manager-inspect'}));
if(process.argv.includes('--install')){
  const index=process.argv.indexOf('--expected-integrity'),expected=process.argv[index+1];
  if(index<0||expected!==preview.integrity||preview.id!==packageId||preview.blockers.length)throw new Error('POSE_INSTALL_PREVIEW_MISMATCH');
  const existing=lock.packages[packageId];
  if(existing&&existing.integrity!==preview.integrity)throw new Error('POSE_INSTALLED_SOURCE_DIFFERS');
  const installed=existing??await manager.install(profileDir,source,{expectedIntegrity:preview.integrity});
  await manager.trust(profileDir,packageId,{integrity:installed.integrity,capabilityHash:capabilityHash(installed)});
  const enabled=await manager.setEnabled(profileDir,packageId,true,{expectedInstalledIntegrity:installed.integrity});
  const pin=await manager.pinRuntimeSnapshot(profileDir,{pinId:activeRuntimePinId({packageId,integrity:enabled.integrity}),operationId:'photo-cad-pose-setup-v1',packageId,purpose:'active',selector:{kind:'installed',expectedIntegrity:enabled.integrity,expectedTreeIntegrity:enabled.treeIntegrity}});
  const yamlFile=join(profileDir,'profile.yaml');
  const profile=yaml.parse(await readFile(yamlFile,'utf8'));
  if(!profile.packages.some(p=>p.id===packageId))profile.packages.push({id:packageId,source:'file:./pose-agh-plugin',version:preview.version,enabled:true});
  if(!profile.presets.allowed.includes('pose-tools'))profile.presets.allowed.push('pose-tools');
  await writeFile(yamlFile,yaml.stringify(profile));
  console.log(JSON.stringify({id:packageId,integrity:enabled.integrity,trusted:Boolean(enabled.state.trusted),enabled:enabled.state.enabled===true,activeSnapshot:pin.snapshot.snapshotId,profileDefault:profile.presets.default,mode:'official-install-trust-enable-pin-with-explicit-profile-reference'}));
}
