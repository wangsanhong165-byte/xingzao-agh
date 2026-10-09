import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {analyzeSupportPaths} from '../../src/support-evaluation.mjs';
const base=new URL('./',import.meta.url),record=JSON.parse(await readFile(new URL('case.json',base),'utf8'));
for(const c of record.cases){if(!['upright.gcode','face-up.gcode'].includes(c.gcode))throw Error('CASE_PATH_INVALID');const b=await readFile(new URL(c.gcode,base));if(createHash('sha256').update(b).digest('hex')!==c.gcodeSha256)throw Error('GCODE_CHANGED');const a=analyzeSupportPaths(b.toString('utf8'),c.options),r=a.regions.find(r=>r.id==='important-region');if(!a.verified||Math.abs(r.supportPathLengthMm-c.expectedSupportPathLengthMm)>1e-6)throw Error('ROI_RECHECK_FAILED');console.log(c.poseId+': '+r.supportPathLengthMm+' mm verified');}
