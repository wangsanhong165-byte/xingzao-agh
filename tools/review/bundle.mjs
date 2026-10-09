import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultSnapshotPath = path.join(repoRoot, 'data', 'review-evidence-20261007', 'snapshot.json');
const allowedExtensions = new Set(['.stl', '.gcode', '.json', '.ini', '.png']);
const forbiddenName = /(?:^|[\/._-])(?:env|secret|secrets|credential|credentials|password|token|api[-_]?key)(?:$|[\/._-])/iu;
const excludedTrackedPath = /^(?:data|\.git|node_modules|\.venv)(?:\/|$)|^\.env(?:\.|$)/iu;
const includedDirectories = new Set([
  'src/', 'tools/', 'public/', 'tests/', 'docs/',
  'agh-plugin/', 'pose-agh-plugin/', 'print-agh-plugin/',
  'reconstruction-agh-plugin/', 'repair-agh-plugin/', 'texture-agh-plugin/',
]);

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeRelative(value, label, { requireData = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) {
    throw new Error(`${label} must be a safe relative path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || /[\u0000-\u001f\u007f]/u.test(part))) {
    throw new Error(`${label} must be a safe relative path`);
  }
  if (requireData && parts[0] !== 'data') throw new Error(`${label} must be inside data/`);
  return parts.join('/');
}

function validateArtifactName(value) {
  const name = safeRelative(value, 'artifact name');
  if (!name.startsWith('case/') || forbiddenName.test(name)) throw new Error(`artifact name is not allowed: ${name}`);
  if (!allowedExtensions.has(path.posix.extname(name).toLowerCase())) throw new Error(`artifact name has a forbidden extension: ${name}`);
  return name;
}

function validateSummary(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('snapshot summary must be an object');
  const visit = (item, depth) => {
    if (depth > 8) throw new Error('snapshot summary is too deeply nested');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { for (const entry of item) visit(entry, depth + 1); return; }
    if (typeof item !== 'object') throw new Error('snapshot summary contains an unsupported value');
    for (const [key, entry] of Object.entries(item)) {
      if (forbiddenName.test(key)) throw new Error(`snapshot summary contains a forbidden key: ${key}`);
      visit(entry, depth + 1);
    }
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 64 * 1024) throw new Error('snapshot summary exceeds 64 KiB');
  return value;
}

async function assertRegularInside(root, relative, label) {
  const absolute = path.resolve(root, ...relative.split('/'));
  if (!isInside(root, absolute)) throw new Error(`${label} escapes its allowed root`);
  let current = root;
  const segments = relative.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (info.isDirectory() && i === segments.length - 1) || (!info.isDirectory() && i < segments.length - 1)) {
      throw new Error(`${label} must not use links or non-file path components`);
    }
  }
  const info = await lstat(absolute);
  if (!info.isFile()) throw new Error(`${label} must be a regular file`);
  const resolved = await realpath(absolute);
  if (!isInside(root, resolved)) throw new Error(`${label} resolves outside its allowed root`);
  return { absolute, info };
}

async function ensureDirectoryPath(repo, relative) {
  const absolute = path.resolve(repo, ...relative.split('/'));
  if (!isInside(path.join(repo, 'data'), absolute)) throw new Error('outputRoot must be inside data/review-bundles');
  if (path.relative(path.join(repo, 'data', 'review-bundles'), absolute).startsWith(`..${path.sep}`)
    || absolute !== path.join(repo, 'data', 'review-bundles') && !isInside(path.join(repo, 'data', 'review-bundles'), absolute)) {
    throw new Error('outputRoot must be inside data/review-bundles');
  }
  const rel = path.relative(repo, absolute).split(path.sep).join('/');
  let current = repo;
  for (const segment of rel.split('/')) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('outputRoot path must not contain links or non-directories');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
  return absolute;
}

function isBundledCodeFile(name) {
  if (excludedTrackedPath.test(name) || name.includes('\\') || name.startsWith('/')) return false;
  if(name.split('/').some(part=>/^\.env(?:\.|$)/iu.test(part))||/\.(?:db|sqlite3?|log|jsonl)$/iu.test(name))return false;
  if(name.split('/').some(part=>/^(?:weights|modelcache|checkpoints|node_modules|site-packages)$/iu.test(part))||/\.(?:safetensors|pt|pth|bin|onnx|ckpt|gguf)$/iu.test(name))return false;
  if (['package.json', 'package-lock.json', 'README.md'].includes(name) || /^LICENSE(?:\.|$)/iu.test(name)) return true;
  if ([...includedDirectories].some((prefix) => name.startsWith(prefix))) return true;
  return false;
}

async function listCodeFiles(root, provided) {
  let git=process.env.PHOTO_CAD_GIT||'git';
  if(!process.env.PHOTO_CAD_GIT){const bundled=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd/git.exe');if(await lstat(bundled).then(s=>s.isFile(),()=>false))git=bundled;}
  const tracked = provided ? await provided(root) : (await execFile(git, ['ls-files', '-z'], {
    cwd: root, shell: false, windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
    env: Object.fromEntries(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
  })).stdout.split('\0').filter(Boolean);
  const selected = new Set(tracked.filter(isBundledCodeFile));
  const reviewDir = path.join(root, 'tools', 'review');
  try {
    for (const entry of await readdir(reviewDir, { withFileTypes: true })) {
      if (entry.isFile() && ['.mjs', '.py', '.ps1'].includes(path.extname(entry.name).toLowerCase())) selected.add(`tools/review/${entry.name}`);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for(const doc of await readdir(path.join(root,'docs')).catch(()=>[]))if(/^review.*\.md$/u.test(doc)){const name='docs/'+doc;try{const info=await lstat(path.join(root,name));if(info.isFile()&&!info.isSymbolicLink())selected.add(name);}catch{}}
  return [...selected].sort();
}

async function zipDirectory(pythonPath, parent, basename) {
  const script = [
    'import os, sys, zipfile',
    'name = sys.argv[1]',
    'archive = name + ".zip"',
    'with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:',
    '    for root, dirs, files in os.walk(name, followlinks=False):',
    '        dirs.sort(); files.sort()',
    '        for filename in files:',
    '            full = os.path.join(root, filename)',
    '            if os.path.islink(full): raise RuntimeError("symlink in bundle")',
    '            z.write(full, os.path.join(name, os.path.relpath(full, name)).replace(os.sep, "/"))',
  ].join('\n');
  await execFile(pythonPath, ['-I', '-c', script, basename], {
    cwd: parent, shell: false, windowsHide: true, timeout: 300_000, maxBuffer: 64 * 1024,
    env: Object.fromEntries(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
  });
}

export async function buildReviewBundle({
  snapshotPath = defaultSnapshotPath,
  outputRoot = 'data/review-bundles',
  archive = true,
  pythonPath,
  repoRoot: rootOverride = repoRoot,
  codeFiles,
  uuid = randomUUID(),
  maxFileBytes = 25 * 1024 * 1024,
  maxTotalBytes = 190 * 1024 * 1024,
} = {}) {
  const root = path.resolve(rootOverride);
  const dataRoot = path.join(root, 'data');
  const snapshotAbsolute = path.resolve(snapshotPath);
  if (!isInside(dataRoot, snapshotAbsolute)) throw new Error('snapshotPath must be inside repo data/');
  const snapshotRelative = path.relative(dataRoot, snapshotAbsolute).split(path.sep).join('/');
  const { info: snapshotInfo } = await assertRegularInside(dataRoot, snapshotRelative, 'snapshotPath');
  const snapshotText = await readFile(snapshotAbsolute, 'utf8');
  if (Buffer.byteLength(snapshotText, 'utf8') > 256 * 1024) throw new Error('snapshot exceeds 256 KiB');
  let snapshot;
  try { snapshot = JSON.parse(snapshotText); } catch { throw new Error('snapshot must contain valid JSON'); }
  if (snapshot?.schema !== 'xingzao-review-snapshot/v1' || !Array.isArray(snapshot.artifacts) || !Object.hasOwn(snapshot, 'summary')) {
    throw new Error('snapshot schema must be xingzao-review-snapshot/v1 with artifacts and summary');
  }
  const summary = validateSummary(snapshot.summary);
  if (snapshot.artifacts.length === 0 || snapshot.artifacts.length > 256) throw new Error('snapshot artifacts must contain 1 to 256 entries');
  const artifactNames = new Set();
  const artifacts = [];
  let evidenceBytes = 0;
  for (const item of snapshot.artifacts) {
    const name = validateArtifactName(item?.name);
    const sourcePath = safeRelative(item?.sourcePath, 'sourcePath', { requireData: true });
    if (!allowedExtensions.has(path.posix.extname(sourcePath).toLowerCase()) || forbiddenName.test(sourcePath)) throw new Error(`sourcePath is not allowed: ${sourcePath}`);
    if (artifactNames.has(name)) throw new Error(`duplicate artifact name: ${name}`);
    artifactNames.add(name);
    if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw new Error(`artifact SHA-256 is invalid: ${name}`);
    const { absolute, info } = await assertRegularInside(dataRoot, sourcePath.slice('data/'.length), `sourcePath ${sourcePath}`);
    if (info.size > maxFileBytes) throw new Error(`artifact exceeds per-file size cap: ${name}`);
    evidenceBytes += info.size;
    if (evidenceBytes > maxTotalBytes) throw new Error('artifacts exceed total size cap');
    const bytes = await readFile(absolute);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== item.sha256) throw new Error(`artifact SHA-256 mismatch: ${name}`);
    artifacts.push({ name, sourcePath, sha256, bytes });
  }

  const files = [];
  const names = new Set();
  let payloadBytes=0;
  const addFile = (name, bytes, kind) => {
    if (names.has(name)) throw new Error(`bundle path collision: ${name}`);
    if(bytes.length>maxFileBytes)throw new Error(`file exceeds per-file size cap: ${name}`);
    payloadBytes+=bytes.length;if(payloadBytes>maxTotalBytes)throw new Error('assembled payload exceeds total size cap');
    if(files.length>=510)throw new Error('bundle file count exceeds review limit');
    names.add(name);
    files.push({ name, bytes, kind, sha256: createHash('sha256').update(bytes).digest('hex') });
  };
  for (const artifact of artifacts) addFile(artifact.name, artifact.bytes, 'evidence');
  addFile('evidence/review-snapshot.json', Buffer.from(`${JSON.stringify({ schema: snapshot.schema, artifacts: snapshot.artifacts, summary }, null, 2)}\n`), 'snapshot');
  for (const codeName of await listCodeFiles(root, codeFiles)) {
    const name = safeRelative(codeName, 'code path');
    if (!isBundledCodeFile(name) && !name.startsWith('tools/review/')) throw new Error(`code path is outside the source allowlist: ${name}`);
    if (name.startsWith('tools/review/') && !['.mjs', '.py', '.ps1'].includes(path.posix.extname(name).toLowerCase())) continue;
    const { absolute } = await assertRegularInside(root, name, `code path ${name}`);
    if((await lstat(absolute)).size>maxFileBytes)throw new Error(`source exceeds per-file size cap: ${name}`);
    addFile(name, await readFile(absolute), 'source');
  }

  const rootRelative = typeof outputRoot === 'string' ? outputRoot : '';
  if (!rootRelative || rootRelative.includes('\\') || path.posix.isAbsolute(rootRelative) || /^[A-Za-z]:/u.test(rootRelative)) throw new Error('outputRoot must be relative to the repository');
  const cleanOutput = safeRelative(rootRelative, 'outputRoot');
  if (cleanOutput !== 'data/review-bundles' && !cleanOutput.startsWith('data/review-bundles/')) throw new Error('outputRoot must be inside data/review-bundles');
  const outputAbsolute = await ensureDirectoryPath(root, cleanOutput);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(uuid)) throw new Error('uuid must be a UUID v4');
  const directory = path.join(outputAbsolute, uuid);
  const zipPath = `${directory}.zip`;
  try { await stat(directory); throw new Error('bundle destination already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await stat(zipPath); throw new Error('bundle ZIP destination already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(directory);
  for (const file of files) {
    const target = path.resolve(directory, ...file.name.split('/'));
    if (!isInside(directory, target)) throw new Error(`bundle path escapes destination: ${file.name}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { flag: 'wx' });
  }
  const claims = {
    cachedEvidenceVerification: true,
    liveModelRequestVerified: false,
    inferenceVerified: false,
    physicalPrintVerified: false,
  };
  const manifest = {
    schema: 'xingzao-review-bundle/v1',
    createdAt: new Date().toISOString(),
    evidenceBytes,
    payloadBytes,
    summary,
    claims,
    files: files.map(({ name, kind, bytes, sha256 }) => ({ path: name, kind, bytes: bytes.length, sha256 })),
    manifestExcludesSelf: true,
  };
  await writeFile(path.join(directory, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  const selectedPython = pythonPath || process.env.PHOTO_CAD_MESH_PYTHON || path.join(root, 'data', 'reconstruction', 'env-torch-readonly', 'Scripts', 'python.exe');
  if (archive) await zipDirectory(selectedPython, outputAbsolute, uuid);
  const zipInfo = archive ? await stat(zipPath) : null;
  return { directory, zipPath: archive ? zipPath : null, fileCount: files.length + 1, evidenceBytes, zipBytes: zipInfo?.size ?? null, claims };
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--no-archive') { options.archive = false; continue; }
    if (!['--snapshot', '--output-root', '--python'].includes(arg) || !args[i + 1]) throw new TypeError(`Unknown or incomplete argument: ${arg}`);
    const key = { '--snapshot': 'snapshotPath', '--output-root': 'outputRoot', '--python': 'pythonPath' }[arg];
    options[key] = args[++i];
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildReviewBundle(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Review bundle failed: ${error.message}\nUsage: node tools/review/bundle.mjs [--snapshot path] [--output-root data/review-bundles] [--python executable] [--no-archive]\n`);
    process.exitCode = 2;
  }
}
