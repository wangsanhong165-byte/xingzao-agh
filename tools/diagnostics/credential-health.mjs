import {readFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {printAghInternals} from '../../src/print-agh.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),source=join(root,'data/agh-source'),home=printAghInternals.reconstructionHome(process.env);
await import(pathToFileURL(join(source,'node_modules/tsx/dist/loader.mjs')).href);
const {createCredentialStore}=await import(pathToFileURL(join(source,'packages/host/src/adapters/credential-store.ts')).href);
const {hasPrivateDaclSync}=await import(pathToFileURL(join(source,'packages/system-node/src/index.ts')).href);
const cfg=JSON.parse(await readFile(join(home,'profiles/local-dev/configuration.json'),'utf8'));
const account=cfg.accounts.find(a=>a.accountId===cfg.defaultAccountId&&a.enabled);
const providerId=account?.id??account?.providerId;
if(!['agnes-ai','command-code'].includes(providerId))throw new Error('CREDENTIAL_HEALTH_PROVIDER_UNSUPPORTED');
const store=createCredentialStore({root:home});
const health={enforcement:store.enforcement,privateDirectories:{},credentialReadable:false};
for(const [name,p] of Object.entries({home,secrets:join(home,'secrets'),provider:join(home,'secrets',providerId)})){
  try{health.privateDirectories[name]=hasPrivateDaclSync(p);}catch(e){health.privateDirectories[name]=e.code??'ERROR';}
}
try{const value=await store.read(account.credentialRef);health.credentialReadable=Boolean(value&&value.kind==='api-key'&&value.provider===providerId&&value.value);}catch(e){health.error={code:e.code??null,reason:e.reason??null};}
console.log(JSON.stringify(health));
