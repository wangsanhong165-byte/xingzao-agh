import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PrintJobStore, PLANAR_POLICY } from '../src/print-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const folder = path.join(root, 'data', 'print-validation', 'planar-cases');
await mkdir(folder, { recursive: true });
const cases = [
  { name: 'ring', kind: 'normal', drawing: ['cv2.circle(im,(120,90),52,0,12)'] },
  { name: 'letter-H', kind: 'normal', drawing: ['cv2.rectangle(im,(66,35),(80,145),0,-1)', 'cv2.rectangle(im,(160,35),(174,145),0,-1)', 'cv2.rectangle(im,(80,82),(160,98),0,-1)'] },
  { name: 'two-components', kind: 'normal', drawing: ['cv2.circle(im,(72,90),27,0,-1)', 'cv2.rectangle(im,(139,55),(185,125),0,-1)'] },
  { name: 'two-holes', kind: 'normal', drawing: ['cv2.rectangle(im,(65,35),(175,145),0,-1)', 'cv2.circle(im,(120,63),18,255,-1)', 'cv2.circle(im,(120,117),18,255,-1)'] },
  { name: 'partial-roi', kind: 'boundary', drawing: ['cv2.circle(im,(164,92),32,0,9)'], roi: { x: 116, y: 43, width: 96, height: 98 } },
  { name: 'minimum-height', kind: 'boundary', drawing: ['cv2.circle(im,(120,90),52,0,12)'], maxHeight: .2 },
  { name: 'blank-input', kind: 'failure', drawing: [] },
  { name: 'out-of-range-roi', kind: 'failure', drawing: ['cv2.circle(im,(120,90),52,0,12)'], roi: { x: 230, y: 0, width: 40, height: 180 } },
];
const store = new PrintJobStore();
const rows = [];
for (const fixture of cases) {
  const bytes = execFileSync(path.join(root, '.venv', 'Scripts', 'python.exe'), ['-c', ['import cv2,numpy as np,sys', 'im=np.full((180,240),255,np.uint8)', ...fixture.drawing, 'ok,b=cv2.imencode(".png",im)', 'sys.stdout.buffer.write(b.tobytes())'].join(';')], { windowsHide: true });
  await writeFile(path.join(folder, `${fixture.name}.png`), bytes);
  const job = await store.create({ image: { name: `${fixture.name}.png`, mime: 'image/png', dataBase64: bytes.toString('base64') }, dimensions: { width: 40, depth: 30, baseThickness: 2 }, roi: fixture.roi ?? { x: 0, y: 0, width: 240, height: 180 }, constraints: { minFeatureWidth: .8, reliefHeight: .2, maxReliefHeight: fixture.maxHeight ?? .6, minFidelity: .85 }, profileId: 'fdm-pla-04' });
  const row = { name: fixture.name, kind: fixture.kind, jobId: job.id, candidates: [], submitted: false };
  const inspection = await store.execute(job.id, 'inspect');
  row.inspectionSuccess = inspection.success;
  if (!inspection.success) row.reason = inspection.reason;
  else {
    for (const height of [0, .2, .4]) {
      if (height > (fixture.maxHeight ?? .6)) continue;
      const built = await store.execute(job.id, 'build', { options: { enhance: height !== 0, reliefHeight: Math.max(height, .2) } });
      const result = { height, candidateId: built.candidateId, geometrySuccess: built.success };
      if (built.success) {
        const slice = await store.execute(job.id, 'slice', { candidateId: built.candidateId });
        result.sliceSuccess = slice.success;
        if (slice.success) {
          const verified = await store.execute(job.id, 'verify', { candidateId: built.candidateId });
          result.verificationSuccess = verified.success;
          result.reason = verified.reason;
          result.fidelity = verified.fidelity;
          result.footprint = verified.footprint;
          result.metrics = slice.metrics;
          if (verified.success && !row.submitted) row.submitted = (await store.execute(job.id, 'submit', { candidateId: built.candidateId })).success;
        } else result.reason = slice.reason;
      } else result.reason = built.reason ?? 'Geometry checks failed';
      row.candidates.push(result);
    }
  }
  rows.push(row);
  console.log(JSON.stringify({ name: row.name, kind: row.kind, inspectionSuccess: row.inspectionSuccess, submitted: row.submitted, outcomes: row.candidates.map(candidate => ({ height: candidate.height, geometry: candidate.geometrySuccess, verified: candidate.verificationSuccess, coverage: candidate.footprint?.targetCoverageFraction, reason: candidate.reason })) }));
}
await writeFile(path.join(folder, 'results.json'), JSON.stringify({ createdAt: new Date().toISOString(), source: 'controlled synthetic images; direct real geometry/slicer/evaluator, not AGH inference or physical print', policy: PLANAR_POLICY, rows }, null, 2));
