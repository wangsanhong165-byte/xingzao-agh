import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createReconstructionRouter } from './reconstruction-http.mjs';
import { createPoseRouter } from './pose-http.mjs';
import { createRepairRouter } from './repair-http.mjs';
import { createTextureRouter } from './texture-http.mjs';
import { TextureJobStore } from './texture-jobs.mjs';
import {createWorkflowRouter} from './workflow-http.mjs';
import {createProtectRouter} from './surface-protection-http.mjs';
import {createApplicationCaseRouter} from './application-case-http.mjs';
import {createSubmissionRouter} from './submission-assets-http.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const jobsRoot = path.join(root, 'data', 'print-jobs');
const threeRoot = path.join(root, 'node_modules', 'three');
const defaultGeometry = {
  inspect: async (input) => (await import('./detail-geometry.mjs')).inspectDetail(input),
  build: async (input, options) => (await import('./detail-geometry.mjs')).buildDetail(input, options),
};
const defaultSlicer = {
  slice: async (request) => (await import('./slicer.mjs')).sliceArtifact(request),
  analyze: async (text, request) => (await import('./slicer.mjs')).analyzeDetailPaths(text, request),
};
const defaultEvaluator = { evaluate: async (text, options) => (await import('./detail-evaluation.mjs')).evaluatePlanarDetail(text, options) };
export const PLANAR_POLICY = Object.freeze({ version: 'planar-path-v2', minTargetCoverage: .90, maxSpillFraction: .15, minHoleRemainingFraction: .80, minModelLayers: 2 });
const failure = (reason, nextActions = []) => ({ success: false, reason, nextActions });
const compactGeometry = (result) => ({ candidateId: result.candidateId, metrics: result.metrics, checks: result.checks, warnings: result.warnings, detail: { fidelity: result.detail?.fidelity, minWidthMm: result.detail?.minWidthMm, minWidthIsTarget: result.detail?.minWidthIsTarget, baseZ: result.detail?.baseZ, featureBoundsMm: result.detail?.featureBoundsMm } });
function geometryChecksPassed(geometry) {
  const checks = geometry?.checks;
  return Array.isArray(checks) && !checks.some(check => check.status === 'fail') &&
    ['closed-mesh', 'exterior-bounds', 'base-thickness', 'raised-relief'].every(name => checks.some(check => check.name === name && check.status === 'pass'));
}

export class PrintJobStore {
  constructor({ geometry = defaultGeometry, slicer = defaultSlicer, evaluator = defaultEvaluator, persist = true } = {}) { this.geometry = geometry; this.slicer = slicer; this.evaluator = evaluator; this.persist = persist; this.jobs = new Map(); }
  async create(input) {
    const job = { id: randomUUID(), input: structuredClone(input), stage: 'created', createdAt: new Date().toISOString(), events: [], candidates: {}, submittedCandidateId: null, agentRunActive: false, accessToken: randomBytes(24).toString('hex') };
    this.jobs.set(job.id, job); await this.save(job); return job;
  }
  get(id) { return this.jobs.get(id); }
  async load(id) {
    if (this.jobs.has(id)) return this.jobs.get(id);
    if (!this.persist || !/^[a-f0-9-]{36}$/.test(id)) return null;
    try {
      const job = JSON.parse(await readFile(path.join(jobsRoot, id, 'state.json'), 'utf8'));
      if (job.id !== id || !job.candidates || !Array.isArray(job.events)) return null;
      if (job.agentRunActive) {
        job.agentRunActive = false;
        job.stage = 'interrupted';
        job.error = '工作台重启中断了这次任务，请重新运行；已完成步骤保留。';
        job.accessToken = randomBytes(24).toString('hex');
        await this.save(job);
      }
      this.jobs.set(id, job);
      return job;
    } catch { return null; }
  }
  async finish(id, result) {
    const job = this.get(id);
    if (!job) return;
    job.execution = result.execution;
    job.agentOutput = result.agentOutput;
    job.agentRunActive = false;
    if (!result.success) {
      job.stage = 'failed';
      job.error = result.reason || 'AGH_RUN_FAILED';
    } else if (!job.submittedCandidateId) {
      job.stage = 'incomplete';
      job.error = 'AGH 结束时没有提交通过复核的候选。';
    }
    await this.save(job);
  }
  async save(job) { if (!this.persist) return; const dir = path.join(jobsRoot, job.id); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'state.json'), JSON.stringify(job)); }
  async event(job, tool, result, source) { job.events.push({ at: new Date().toISOString(), tool, source, success: result.success, candidateId: result.candidateId || null, message: result.reason || result.message || '工具完成' }); await this.save(job); }
  async execute(id, tool, args = {}, source = 'system') {
    const job = this.get(id);
    if (!job) return failure('任务不存在。');
    if (source === 'agh' && job.events.filter(event => event.source === 'agh').length >= 12) return failure('已达到 12 次任务工具预算，请停止并报告当前问题。');
    let result;
    try {
      if (tool === 'inspect') {
        const inspection = await this.geometry.inspect(job.input);
        const summary = { ...compactGeometry(inspection), spec: inspection.spec, targetTopology: inspection.detail?.targetTopology, enhancedTopology: inspection.detail?.enhancedTopology, meshGrid: inspection.detail?.meshGrid };
        result = { success: true, jobId: id, inspection: summary, constraints: job.input.constraints, verificationPolicy: PLANAR_POLICY, dimensions: job.input.dimensions, profileId: job.input.profileId || 'fdm-pla-04', baselineCandidateId: job.baselineCandidateId || null };
      } else if (tool === 'build') {
        const options = { enhance: args.options?.enhance !== false, reliefHeight: args.options?.reliefHeight ?? job.input.constraints?.reliefHeight ?? .6, minFeatureWidth: args.options?.minFeatureWidth ?? job.input.constraints?.minFeatureWidth ?? .8 };
        if (options.reliefHeight > (job.input.constraints?.maxReliefHeight ?? 1.2) || options.minFeatureWidth < (job.input.constraints?.minFeatureWidth ?? .8)) throw new Error('候选修改违反最大凸起或最小特征宽度约束。');
        const geometry = await this.geometry.build(job.input, options);
        if (typeof geometry.candidateId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(geometry.candidateId)) throw new Error('几何工具没有返回合法候选 ID。');
        const previous = job.candidates[geometry.candidateId];
        job.candidates[geometry.candidateId] = { ...previous, geometry, options };
        if (!options.enhance) job.baselineCandidateId = geometry.candidateId;
        result = { success: geometryChecksPassed(geometry), ...compactGeometry(geometry), options, jobId: id };
      } else {
        const candidate = job.candidates[args.candidateId];
        if (!candidate) result = failure('候选不属于当前任务或不存在。', ['调用 build 生成当前任务的候选。']);
        else if (tool === 'slice') {
          if (!geometryChecksPassed(candidate.geometry)) result = failure('闭合、外边界或厚度的几何检查缺失或尚未通过，不能切片。');
          else {
            candidate.slice = await this.slicer.slice({ stlPath: candidate.geometry.stlPath, outputDir: path.join(jobsRoot, id, args.candidateId), profileId: job.input.profileId || 'fdm-pla-04' });
            candidate.verification = null;
            result = { success: candidate.slice.execution?.mode === 'actual-slicer', jobId: id, candidateId: args.candidateId, metrics: candidate.slice.metrics, profile: candidate.slice.profile, placementOffsetMm: candidate.slice.placementOffsetMm, execution: candidate.slice.execution };
          }
        } else if (tool === 'verify') {
          if (candidate.slice?.execution?.mode !== 'actual-slicer') result = failure('候选未完成真实切片，无法复核。');
          else {
            const text = candidate.slice.gcodeText ?? await readFile(candidate.slice.gcodePath, 'utf8');
            const detail = candidate.geometry.detail || {};
            const verification = await this.slicer.analyze(text, { baseZ: detail.baseZ ?? job.input.dimensions?.baseThickness, featureBoundsMm: detail.featureBoundsMm, nozzleDiameter: .4, placementOffsetMm: candidate.slice.placementOffsetMm, targetMask: detail.targetMask, widthMm: job.input.dimensions?.width, depthMm: job.input.dimensions?.depth, enhance: candidate.options.enhance });
            const fidelity = detail.fidelity ?? candidate.geometry.metrics?.fidelity;
            const fidelityOk = Number.isFinite(fidelity) && fidelity >= (job.input.constraints?.minFidelity ?? .75);
            const geometryOk = geometryChecksPassed(candidate.geometry);
            const measured = await this.evaluator.evaluate(text, { targetMask: detail.targetMask, widthMm: job.input.dimensions?.width, depthMm: job.input.dimensions?.depth, baseZ: detail.baseZ ?? job.input.dimensions?.baseThickness, reliefHeight: candidate.options.reliefHeight, placementOffsetMm: candidate.slice.placementOffsetMm, rasterStepMm: .1, targetHoleRemainingFraction: PLANAR_POLICY.minHoleRemainingFraction });
            const { previewSvg: footprintSvg, ...footprint } = measured;
            const coverageOk = Number.isFinite(footprint.targetCoverageFraction) && footprint.targetCoverageFraction >= PLANAR_POLICY.minTargetCoverage;
            const spillOk = Number.isFinite(footprint.spillFraction) && footprint.spillFraction <= PLANAR_POLICY.maxSpillFraction;
            const holesOk = footprint.targetHoleCount === 0 || (footprint.holeEvidence?.verified === true && footprint.survivingTargetHoleCount === footprint.targetHoleCount);
            const pathsOk = footprint.evaluation?.verified === true && footprint.modelRaisedLayerCount >= PLANAR_POLICY.minModelLayers && footprint.modelAboveReliefLengthMm === 0;
            const success = geometryOk && fidelityOk && verification.hasRaisedDetail === true && verification.featureLayerCount >= 2 && pathsOk && coverageOk && spillOk && holesOk;
            const reason = success ? undefined : !geometryOk ? '几何检查尚未通过。' : !fidelityOk ? '局部增强的保真指标低于用户要求。' : !verification.hasRaisedDetail || verification.featureLayerCount < 2 ? '目标区域没有至少两层真实浮雕挤出路径，细节尚未保护。' : !pathsOk ? '模型路径role、线宽或高度尚未完整验证。' : !coverageOk ? '目标图案的模型挤出覆盖不足90%。' : !spillOk ? '模型挤出超出目标图案的比例超过15%。' : '目标孔洞余量或连通性未满足保护要求。';
            candidate.verification = { ...verification, previewSvg: footprintSvg || verification.previewSvg, footprint, success, fidelity, reason, criteria: { minFidelity: job.input.constraints?.minFidelity ?? .75, minFeatureLayers: 2, ...PLANAR_POLICY } };
            const { previewSvg, ...verificationSummary } = candidate.verification;
            result = { ...verificationSummary, jobId: id, candidateId: args.candidateId, nextActions: success ? [] : ['根据失败原因重新 build；新候选必须重新 slice 与 verify。'] };
          }
        } else if (tool === 'submit') {
          if (candidate.slice?.execution?.mode !== 'actual-slicer' || !candidate.verification?.success) result = failure('最终候选必须先完成真实切片并通过路径复核。');
          else { job.submittedCandidateId = args.candidateId; job.stage = 'submitted'; result = { success: true, jobId: id, candidateId: args.candidateId, message: '候选已提交；几何与切片复核通过，实物效果尚未验证。', metrics: candidate.slice.metrics, verification: { featureLayerCount: candidate.verification.featureLayerCount, featureExtrusionLengthMm: candidate.verification.featureExtrusionLengthMm, fidelity: candidate.verification.fidelity } }; }
        } else result = failure('未知打印工具。');
      }
    } catch (error) { result = failure(error.message || '工具执行失败。', ['检查实际返回错误并调整允许修改的参数，不能改变硬尺寸。']); }
    if (job.stage !== 'submitted') job.stage = result.success ? tool : `${tool}_failed`;
    await this.event(job, tool, result, source); return result;
  }
  publicJob(job) {
    return { id: job.id, stage: job.stage, createdAt: job.createdAt, agentRunActive: job.agentRunActive, execution: job.execution, error: job.error, events: job.events, submittedCandidateId: job.submittedCandidateId, baselineCandidateId: job.baselineCandidateId, requestOptions: { dimensions: job.input.dimensions, roi: job.input.roi, profileId: job.input.profileId, constraints: job.input.constraints, imageName: job.input.image?.name }, sourceImageUrl: `/api/print/jobs/${job.id}/source`, candidates: Object.values(job.candidates).map(candidate => ({ ...compactGeometry(candidate.geometry), options: candidate.options, slice: candidate.slice ? { metrics: candidate.slice.metrics, profile: candidate.slice.profile, execution: candidate.slice.execution } : null, verification: candidate.verification, mesh: candidate.geometry.mesh })) };
  }
}

function json(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); }
async function body(request, maxMiB = 8) { let size = 0; const chunks = []; for await (const chunk of request) { size += chunk.length; if (size > maxMiB * 1024 * 1024) throw new Error(`请求超过 ${maxMiB} MiB。`); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
export function validatePrintInput(input) {
  if (!input?.image || input.image.mime !== 'image/png' || typeof input.image.dataBase64 !== 'string') throw new Error('请提供高对比 PNG 字样或徽标。');
  if (Buffer.byteLength(input.image.dataBase64, 'base64') > 5 * 1024 * 1024) throw new Error('PNG 超过 5 MiB。');
  for (const key of ['width', 'depth']) if (typeof input.dimensions?.[key] !== 'number' || !Number.isFinite(input.dimensions[key]) || input.dimensions[key] < 1 || input.dimensions[key] > 180) throw new Error('目标宽深须为 1～180 mm。');
  if (typeof input.dimensions.baseThickness !== 'number' || !Number.isFinite(input.dimensions.baseThickness) || input.dimensions.baseThickness < .8 || input.dimensions.baseThickness > 10) throw new Error('底板厚度须为 0.8～10 mm。');
  const constraints = input.constraints;
  if (!constraints || ![constraints.minFeatureWidth, constraints.reliefHeight, constraints.maxReliefHeight, constraints.minFidelity].every(value => typeof value === 'number' && Number.isFinite(value))) throw new Error('请提供有限的保护约束。');
  if (constraints.minFeatureWidth < .4 || constraints.minFeatureWidth > 3 || constraints.reliefHeight < .2 || constraints.maxReliefHeight > 3 || constraints.maxReliefHeight < constraints.reliefHeight || constraints.minFidelity < .5 || constraints.minFidelity > 1) throw new Error('打印保护约束超出本版本范围。');
  if (input.profileId && input.profileId !== 'fdm-pla-04') throw new Error('本版本只支持固定虚拟 FDM 配置。');
  return input;
}

async function printStatus() {
  const [agh, slicer] = await Promise.all([import('./print-agh.mjs').then(module => module.getPrintAghStatus()).catch(() => ({ configured: false, message: 'AGH 正在适配。' })), import('./slicer.mjs').then(module => module.getSlicerStatus()).catch(() => ({ available: false }))]);
  return { agh, slicer, profileId: 'fdm-pla-04', notice: '当前为真实切片验证，未连接打印机。' };
}

export function createPrintApp({ store = new PrintJobStore(), runAgent = async task => (await import('./print-agh.mjs')).runPrintTask(task), reconstruction = createReconstructionRouter(), poses = createPoseRouter(), repairs, textures, workflow, protect, applicationCases, submissionRoot } = {}) {
  repairs ??= createRepairRouter({parentStore:poses.store});
  textures ??= createTextureRouter({store:new TextureJobStore({parentStore:reconstruction.store})});
  workflow ??= createWorkflowRouter({poses:poses.store,repairs:repairs.store});
  protect ??= createProtectRouter({poses:poses.store});
  applicationCases ??= createApplicationCaseRouter({sources:reconstruction.store,textures:textures.store,protections:protect.store});
  const submission=createSubmissionRouter({root:submissionRoot});
  let modelImportActive = false;
  return http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      if(await submission.handle(request,response))return;
      if (request.method === 'POST' && request.headers.origin && ![`http://127.0.0.1:${request.socket.localPort}`, `http://localhost:${request.socket.localPort}`].includes(request.headers.origin)) return json(response, 403, { error: '仅接受本地工作台请求。' });
      if (await reconstruction.handle(request, response)) return;
      if (await poses.handle(request, response)) return;
      if (await repairs.handle(request, response)) return;
      if (await textures.handle(request, response)) return;
      if (await workflow.handle(request, response)) return;
      if (await protect.handle(request, response)) return;
      if (await applicationCases.handle(request,response)) return;
      if (request.method === 'GET' && pathname === '/api/print/status') return json(response, 200, await printStatus());
      if (request.method === 'POST' && pathname === '/api/model-import') {
        if (modelImportActive) return json(response, 409, { error: '正在检查另一份模型，请稍后重试。' });
        modelImportActive = true;
        try {
          const imported = await (await import('./model-import.mjs')).inspectModelUpload(await body(request, 36));
          const { normalizedStlPath, printable, ...summary } = imported;
          return json(response, 200, { ...summary, stlUrl: `/api/model-import/${summary.candidateId}/stl` });
        } finally { modelImportActive = false; }
      }
      const matchImport = pathname.match(/^\/api\/model-import\/([a-f0-9]{64})\/stl$/);
      if (request.method === 'GET' && matchImport) {
        const base = path.join(root, 'data', 'import-jobs');
        const folder = path.join(base, matchImport[1]);
        const paths = [base, folder, path.join(folder, 'summary.json'), path.join(folder, 'normalized.stl')];
        const stats = await Promise.all(paths.map(file => lstat(file).catch(() => null)));
        if (stats.some(stat => !stat || stat.isSymbolicLink()) || !stats[0].isDirectory() || !stats[1].isDirectory() || !stats[2].isFile() || !stats[3].isFile()) return json(response, 404, { error: '模型文件不存在。' });
        const summary = JSON.parse(await readFile(paths[2], 'utf8'));
        const bytes = await readFile(paths[3]);
        if (summary.candidateId !== matchImport[1] || summary.normalizedStlSha256 !== createHash('sha256').update(bytes).digest('hex')) return json(response, 409, { error: '模型文件校验失败，请重新导入。' });
        response.writeHead(200, { 'Content-Type': 'model/stl', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment; filename="normalized-model.stl"', 'Cache-Control': 'no-store' });
        return response.end(bytes);
      }
      if (request.method === 'POST' && pathname === '/api/print/start') {
        const input = validatePrintInput(await body(request)); const job = await store.create(input); job.agentRunActive = true; job.stage = 'agh-starting'; await store.save(job);
        Promise.resolve().then(() => runAgent({ jobId: job.id, task: { dimensions: input.dimensions, constraints: input.constraints, profileId: input.profileId || 'fdm-pla-04', purpose: '先生成未增强的基线并真实切片复核，再根据反馈保护选定字样，最后提交通过检查的增强候选。' }, accessToken: job.accessToken, serviceUrl: `http://127.0.0.1:${request.socket.localPort}` })).then(result => store.finish(job.id, result)).catch(error => store.finish(job.id, { success: false, reason: error.message }));
        return json(response, 202, { id: job.id, stage: job.stage });
      }
      const matchTool = pathname.match(/^\/api\/print\/tool\/(inspect|build|slice|verify|submit)$/);
      if (request.method === 'POST' && matchTool) {
        const input = await body(request); const job = store.get(input.jobId);
        if (!job || !job.agentRunActive || request.headers['x-print-task-access'] !== job.accessToken) return json(response, 403, { success: false, reason: '任务访问凭据不匹配。' });
        return json(response, 200, await store.execute(job.id, matchTool[1], input, 'agh'));
      }
      const matchSource = pathname.match(/^\/api\/print\/jobs\/([a-f0-9-]{36})\/source$/);
      if (request.method === 'GET' && matchSource) {
        const job = await store.load(matchSource[1]);
        if (!job?.input.image) return json(response, 404, { error: '任务图片不存在。' });
        response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return response.end(Buffer.from(job.input.image.dataBase64, 'base64'));
      }
      const matchJob = pathname.match(/^\/api\/print\/jobs\/([a-f0-9-]{36})(?:\/(stl|svg)\/([A-Za-z0-9_-]{1,160}))?$/);
      if (request.method === 'GET' && matchJob) {
        const job = await store.load(matchJob[1]); if (!job) return json(response, 404, { error: '任务不存在。' });
        if (!matchJob[2]) return json(response, 200, store.publicJob(job));
        const candidate = job.candidates[matchJob[3]]; if (!candidate) return json(response, 404, { error: '候选不存在。' });
        if (matchJob[2] === 'svg') {
          if (!candidate.verification?.previewSvg) return json(response, 409, { error: '路径复核与预览尚未就绪。' });
          response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }); return response.end(candidate.verification.previewSvg);
        }
        response.writeHead(200, { 'Content-Type': 'model/stl', 'Content-Disposition': 'attachment; filename="print-detail.stl"' }); return response.end(await readFile(candidate.geometry.stlPath));
      }
      if (request.method === 'GET') {
        let file;
        if (pathname === '/workflow' || pathname === '/workflow.html') file = path.join(root, 'public', 'workflow.html');
        else if (pathname === '/protect' || pathname === '/protect.html') file = path.join(root, 'public', 'protect.html');
        else if (pathname === '/protect.js') file = path.join(root,'public','protect.js');
        else if (['/workflow.js','/workflow.css'].includes(pathname)) file = path.join(root,'public',pathname.slice(1));
        else if (pathname === '/texture' || pathname === '/texture.html') file = path.join(root, 'public', 'texture.html');
        else if (['/texture.js', '/texture.css'].includes(pathname)) file = path.join(root, 'public', pathname.slice(1));
        else if (pathname === '/reconstruct' || pathname === '/reconstruct.html') file = path.join(root, 'public', 'reconstruct.html');
        else if (['/reconstruct.js', '/reconstruct.css'].includes(pathname)) file = path.join(root, 'public', pathname.slice(1));
        else if (pathname === '/poses' || pathname === '/poses.html') file = path.join(root, 'public', 'poses.html');
        else if (['/poses.js', '/poses.css'].includes(pathname)) file = path.join(root, 'public', pathname.slice(1));
        else if (pathname === '/repair' || pathname === '/repair.html') file = path.join(root, 'public', 'repair.html');
        else if (['/repair.js', '/repair.css'].includes(pathname)) file = path.join(root, 'public', pathname.slice(1));
        else if (pathname === '/' || pathname === '/workbench') file = path.join(root, 'public', 'workbench.html');
        else if (['/workbench.js','/workbench.css'].includes(pathname)) file = path.join(root,'public',pathname.slice(1));
        else if(pathname==='/case')file=path.join(root,'public','application-case.html');
        else if(pathname==='/archive-preview')file=path.join(root,'public','archive-preview.html');
        else if(pathname==='/archive-preview.js')file=path.join(root,'public','archive-preview.js');
        else if(['/application-case.js','/application-case.css'].includes(pathname))file=path.join(root,'public',pathname.slice(1));
        else if (pathname === '/print-detail.html') file = path.join(root, 'public', 'print-detail.html');
        else if (['/print-detail.js', '/print-detail.css'].includes(pathname)) file = path.join(root, 'public', pathname.slice(1));
        else if (['/vendor/three.module.js', '/vendor/three.core.js'].includes(pathname)) file = path.join(threeRoot, 'build', path.basename(pathname));
        else if (pathname.startsWith('/vendor/addons/')) { const base = path.join(threeRoot, 'examples', 'jsm'); file = path.resolve(base, pathname.slice('/vendor/addons/'.length)); if (!file.toLowerCase().startsWith((base + path.sep).toLowerCase())) throw new Error('资源路径不合法。'); }
        if (file) { const bytes = await readFile(file); response.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' }); return response.end(bytes); }
      }
      return json(response, 404, { error: '资源不存在。' });
    } catch (error) { if (!response.headersSent) json(response, 400, { error: error.message || '请求失败。' }); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { const port = Number(process.env.PRINT_DETAIL_PORT || 4337); createPrintApp().listen(port, '127.0.0.1', () => console.log(`AGH 打印细节工作台：http://127.0.0.1:${port}`)); }
