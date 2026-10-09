import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildArachneSensitivityProfile} from '../tools/slicer/profile-sensitivity.mjs';

const stock=await readFile(new URL('../tools/slicer/fdm-pla-04-auto-support.ini',import.meta.url),'utf8');
test('baseline tuning preserves every option except declared bead and feature limits',()=>{
 const {text,changes}=buildArachneSensitivityProfile(stock,75);
 const lines=s=>s.split(/\r?\n/u).filter(l=>!/^min_(bead_width|feature_size)\s*=/u.test(l));
 assert.deepEqual(lines(text),lines(stock));
 assert.deepEqual(changes,{min_bead_width:{from:'85%',to:'75%'},min_feature_size:{from:'25%',to:'10%'}});
 assert.match(text,/^support_material = 1$/mu);
 assert.match(text,/^layer_height = 0\.2$/mu);
 assert.match(text,/^min_bead_width = 75%$/mu);
 assert.match(text,/^min_feature_size = 10%$/mu);
});
test('rejects an invalid baseline, ambiguous keys and arbitrary sensitivity values',()=>{
 assert.throws(()=>buildArachneSensitivityProfile(stock.replace('perimeter_generator = arachne','perimeter_generator = classic'),60),/ARACHNE_BASELINE_REQUIRED/u);
 assert.throws(()=>buildArachneSensitivityProfile(stock+'\nmin_bead_width = 70%\n',60),/BASELINE_PROFILE_AMBIGUOUS/u);
 for(const value of [10,50,90,NaN,'60',null])assert.throws(()=>buildArachneSensitivityProfile(stock,value),/BASELINE_SENSITIVITY_INVALID/u);
});
