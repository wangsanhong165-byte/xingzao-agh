import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateModel, exportStl } from '../src/geometry.mjs';
import { sliceArtifact } from '../src/slicer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const previous = {
  spec: { type: 'box', dimensions: { width: 60, depth: 40, height: 25, wallThickness: 2 }, holes: [{ x: 15, y: 0, diameter: 5 }, { x: -15, y: 0, diameter: 5 }] },
  constraints: { bottomThicknessMm: 2, minSideWallMm: 1.2, externalDimensionsFixed: true, holesFixed: true },
};
const folder = path.join(root, 'data', 'material-validation-v2');
await mkdir(folder, { recursive: true });
const results = [];
for (const wallMm of [2, 1.6, 1.2]) {
  const options = { lightweight: wallMm !== 2, minWall: wallMm, preserveMargin: 3 };
  const model = generateModel(previous.spec, options);
  const bytes = exportStl(previous.spec, options);
  const outputDir = path.join(folder, String(wallMm));
  await mkdir(outputDir, { recursive: true });
  const stlPath = path.join(outputDir, 'box.stl');
  await writeFile(stlPath, bytes);
  const sliced = await sliceArtifact({ stlPath, outputDir, profileId: 'fdm-pla-04' });
  results.push({ wallMm, options, stlPath: path.relative(root, stlPath), sha256: createHash('sha256').update(bytes).digest('hex'), geometryMetrics: model.metrics, checks: model.checks, slice: sliced });
  console.log(JSON.stringify({ wallMm, metrics: sliced.metrics }));
}
await writeFile(path.join(folder, 'comparison.json'), JSON.stringify({ createdAt: new Date().toISOString(), kind: 'controlled parametric box; independent actual tools, not AGH inference, photo reconstruction or strength validation', correction: 'cavity overcut extends upwards only; original material-validation artifacts preserved', spec: previous.spec, constraints: previous.constraints, results }, null, 2));
