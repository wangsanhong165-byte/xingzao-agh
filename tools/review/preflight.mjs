import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultMeshPython = path.join(root, 'data', 'reconstruction', 'env-torch-readonly', 'Scripts', 'python.exe');
const pythonProbe = `import importlib.metadata as m, importlib.util as u, json, sys
names = ('numpy', 'trimesh', 'rtree', 'manifold3d')
result = {'pythonVersion': '.'.join(map(str, sys.version_info[:3])), 'packages': {}}
for name in names:
    module = {'manifold3d': 'manifold3d'}.get(name, name)
    spec = u.find_spec(module)
    version = None
    if spec is not None:
        try: version = m.version(name)
        except m.PackageNotFoundError: version = 'installed'
    result['packages'][name] = version
print(json.dumps(result, separators=(',', ':')))`;

export function parseMode(args = []) {
  if (!Array.isArray(args)) throw new TypeError('arguments must be an array');
  let mode = 'offline';
  let seen = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--json') continue;
    if (args[i] !== '--mode') throw new TypeError(`Unknown argument: ${args[i]}`);
    if (seen || !['offline', 'live', 'shape'].includes(args[i + 1])) throw new TypeError('mode must be one of offline, live, or shape');
    mode = args[++i];
    seen = true;
  }
  return mode;
}

function nodeSupported(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version ?? '');
  return Boolean(match && (Number(match[1]) > 24 || (Number(match[1]) === 24 && Number(match[2]) >= 10)));
}

export function buildPreflightReport(mode, checks) {
  if (!['offline', 'live', 'shape'].includes(mode)) throw new TypeError('mode must be one of offline, live, or shape');
  const runtime = checks?.runtime ?? {};
  const slicer = checks?.slicer ?? {};
  const meshReady = nodeSupported(runtime.nodeVersion) && runtime.pythonAvailable === true
    && ['numpy', 'trimesh', 'rtree', 'manifold3d'].every(name => runtime.meshPackages?.[name]?.available === true)
    && slicer.available === true && slicer.profileAvailable === true;
  const liveReady = checks?.printAgh?.ready === true && checks?.repairAgh?.ready === true;
  const hunyuanReady = checks?.hunyuan?.productionStatus === 'configured'
    && checks.hunyuan.aghReady === true && checks.hunyuan.engineConfigured === true;
  const readiness = {
    meshReview: meshReady ? 'ready' : 'blocked',
    liveAgh: liveReady ? 'ready' : (mode === 'offline' ? 'offline-only' : 'blocked'),
    hunyuanShape: hunyuanReady && meshReady ? 'configured' : (mode === 'offline' ? 'offline-only' : 'blocked'),
  };
  const modeReady = mode === 'offline' ? meshReady : mode === 'live' ? meshReady && liveReady : meshReady && hunyuanReady;
  const overall = !modeReady ? 'blocked' : mode === 'shape' ? 'configured' : 'ready';
  return {
    mode, overall, readiness, checks,
    basis: {
      liveAgh: 'getPrintAghStatus and getRepairAghStatus accessors',
      hunyuanShape: 'getReconstructionAghStatus accessor and six production component path checks',
    },
    verification: {
      modelRequestVerified: false,
      inferenceVerified: false,
      gpuExecutionVerified: false,
      cleanMachineReproductionVerified: false,
    },
  };
}

export function exitCodeForReport(report) {
  return report?.overall === 'ready' || report?.overall === 'configured' ? 0 : 1;
}

async function inspectPython(executable) {
  try {
    const { stdout } = await execFile(executable, ['-I', '-c', pythonProbe], {
      windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 16 * 1024,
      env: Object.fromEntries(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]])),
    });
    const data = JSON.parse(stdout.trim());
    const packages = Object.fromEntries(Object.entries(data.packages).map(([name, version]) => [name, { available: version !== null, version }]));
    return { available: true, executable, pythonVersion: data.pythonVersion, meshPackages: packages };
  } catch {
    return { available: false, executable, pythonVersion: null, meshPackages: Object.fromEntries(['numpy', 'trimesh', 'rtree', 'manifold3d'].map(name => [name, { available: false, version: null }])) };
  }
}

async function defaultProviders(env) {
  return {
    runtime: async () => {
      const executable = env.PHOTO_CAD_MESH_PYTHON || defaultMeshPython;
      const python = await inspectPython(executable);
      return { nodeVersion: process.version, nodeSupported: nodeSupported(process.version), pythonExecutable: executable, pythonAvailable: python.available, pythonVersion: python.pythonVersion, meshPackages: python.meshPackages };
    },
    slicer: async () => {
      try {
        const { getSlicerStatus } = await import('../../src/slicer.mjs');
        const status = await getSlicerStatus();
        const { access } = await import('node:fs/promises');
        const profileAvailable = await access(status.profilePath).then(() => true, () => false);
        return { available: status.available === true, version: status.version, executable: status.executable, profileId: status.profileId, profilePath: status.profilePath, profileAvailable };
      } catch {
        return { available: false, version: null, executable: null, profileId: 'fdm-pla-04', profilePath: null, profileAvailable: false };
      }
    },
    printAgh: async () => {
      try { const { getPrintAghStatus } = await import('../../src/print-agh.mjs'); return { ready: (await getPrintAghStatus({ env })).ready === true }; }
      catch { return { ready: false }; }
    },
    repairAgh: async () => {
      try { const { getRepairAghStatus } = await import('../../src/repair-agh.mjs'); return { ready: (await getRepairAghStatus({ env })).ready === true }; }
      catch { return { ready: false }; }
    },
    hunyuan: async () => {
      try {
        const [{ getReconstructionAghStatus }, { reconstructionPaths }] = await Promise.all([import('../../src/reconstruction-agh.mjs'), import('../../src/reconstruction-jobs.mjs')]);
        const status = await getReconstructionAghStatus({ env });
        const { access } = await import('node:fs/promises');
        const enginePaths = ['pythonPath', 'generatorPath', 'sourceScript', 'weightPath', 'configPath', 'manifestPath'].map(key => reconstructionPaths[key]);
        const files = await Promise.all(enginePaths.map(file => access(file).then(() => true, () => false)));
        const engineConfigured = files.length === 6 && files.every(Boolean);
        return { aghReady: status.ready === true, engineConfigured, productionStatus: status.ready === true && engineConfigured ? 'configured' : 'blocked', engineComponentsPresent: files.filter(Boolean).length };
      } catch {
        return { aghReady: false, engineConfigured: false, productionStatus: 'blocked', engineComponentsPresent: 0 };
      }
    },
  };
}

export async function collectPreflight({ mode = 'offline', env = process.env, providers } = {}) {
  if (!['offline', 'live', 'shape'].includes(mode)) throw new TypeError('mode must be one of offline, live, or shape');
  const selected = providers ?? await defaultProviders(env);
  const checks = {};
  checks.runtime = await selected.runtime();
  checks.slicer = await selected.slicer();
  if (mode === 'live') {
    checks.printAgh = await selected.printAgh();
    checks.repairAgh = await selected.repairAgh();
  }
  if (mode === 'shape') checks.hunyuan = await selected.hunyuan();
  return buildPreflightReport(mode, checks);
}

function humanReport(report) {
  const { runtime = {}, slicer = {} } = report.checks;
  return [
    `Preflight mode: ${report.mode} — ${report.overall}`,
    `Mesh review: ${report.readiness.meshReview}`,
    `Live AGH: ${report.readiness.liveAgh} (status accessors; model request not exercised)`,
    `Hunyuan shape: ${report.readiness.hunyuanShape}`,
    `Node: ${runtime.nodeVersion ?? 'unavailable'} (requires >=24.10)`,
    `Mesh Python: ${runtime.pythonAvailable ? `${runtime.pythonVersion} at ${runtime.pythonExecutable}` : `unavailable at ${runtime.pythonExecutable ?? 'configured path'}`}`,
    ...Object.entries(runtime.meshPackages ?? {}).map(([name, item]) => `  ${name}: ${item.available ? item.version : 'missing'}`),
    `Slicer: ${slicer.available ? `${slicer.version} at ${slicer.executable}` : 'unavailable'}`,
    `Slicer profile: ${slicer.profileAvailable ? slicer.profilePath : 'missing'}`,
    ...(report.checks.hunyuan ? [`Hunyuan configuration status: ${report.checks.hunyuan.productionStatus} (${report.checks.hunyuan.engineComponentsPresent}/6 components present)`] : []),
    `Verification: model request=${report.verification.modelRequestVerified}, inference=${report.verification.inferenceVerified}, GPU execution=${report.verification.gpuExecutionVerified}, clean-machine reproduction=${report.verification.cleanMachineReproductionVerified}`,
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = parseMode(process.argv.slice(2));
    const report = await collectPreflight({ mode });
    const json = process.argv.includes('--json');
    process.stdout.write(`${json ? JSON.stringify(report, null, 2) : humanReport(report)}\n`);
    process.exitCode = exitCodeForReport(report);
  } catch (error) {
    process.stderr.write(`Preflight failed: ${error.message}\nUsage: node tools/review/preflight.mjs [--mode offline|live|shape] [--json]\n`);
    process.exitCode = 2;
  }
}
