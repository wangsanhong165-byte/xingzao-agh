// Run after AGH has initialized local-dev. This reads only package/profile state.
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = join(root, 'data/agh-source');
const profileDir = resolve(process.env.USERPROFILE, '.agh-print-detail-v2/profiles/local-dev');
const require = createRequire(join(sourceRoot, 'packages/package-manager/package.json'));
const yaml = require('yaml');
await import(pathToFileURL(join(sourceRoot, 'node_modules/tsx/dist/loader.mjs')).href);
const { createPackageManager } = await import(pathToFileURL(join(sourceRoot, 'packages/package-manager/src/manager.ts')).href);
const { parseSource } = await import(pathToFileURL(join(sourceRoot, 'packages/package-manager/src/sources.ts')).href);
const { capabilityHash } = await import(pathToFileURL(join(sourceRoot, 'packages/package-manager/src/integrity.ts')).href);
const { activeRuntimePinId } = await import(pathToFileURL(join(sourceRoot, 'packages/package-manager/src/package-plugin-loader.ts')).href);
const lock = JSON.parse(await readFile(join(profileDir, 'agnes-lock.json'), 'utf8'));
const home = resolve(profileDir, '../..');
const manager = createPackageManager({ dataDir: join(home, 'data'), agnesVersion: lock.generatedBy.agnesVersion, cwd: root });
const profilePath = join(profileDir, 'profile.yaml');
try {
  await readFile(profilePath, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const template = yaml.parse(await readFile(join(sourceRoot, 'packages/host/templates/local-dev.yaml'), 'utf8'));
  if (process.platform === 'win32') template.presets = { default: 'standard-windows', allowed: ['standard-windows'] };
  template.computerUse.enabled = false;
  await writeFile(profilePath, yaml.stringify(template), { flag: 'wx' });
}
const plugins = [
  ['pose-agh-plugin', '@photo-cad/pose-tools', 'pose-tools'],
  ['repair-agh-plugin', '@photo-cad/feature-repair-tools', 'feature-repair-tools'],
  ['reconstruction-agh-plugin', '@photo-cad/reconstruction-tools', 'reconstruction-tools'],
  ['texture-agh-plugin', '@photo-cad/texture-tools', 'texture-tools'],
];
for (const [directory, id, preset] of plugins) {
  const source = parseSource(`file:./${directory}`);
  const preview = await manager.inspect(profileDir, source);
  if (preview.id !== id || preview.blockers.length) throw new Error(`Plugin inspection failed: ${id}`);
  const currentLock = JSON.parse(await readFile(join(profileDir, 'agnes-lock.json'), 'utf8'));
  const existing = currentLock.packages[id];
  if (existing && existing.integrity !== preview.integrity) throw new Error(`Existing plugin differs: ${id}`);
  const installed = existing ?? await manager.install(profileDir, source, { expectedIntegrity: preview.integrity });
  await manager.trust(profileDir, id, { integrity: installed.integrity, capabilityHash: capabilityHash(installed) });
  const enabled = await manager.setEnabled(profileDir, id, true, { expectedInstalledIntegrity: installed.integrity });
  await manager.pinRuntimeSnapshot(profileDir, {
    pinId: activeRuntimePinId({ packageId: id, integrity: enabled.integrity }),
    operationId: 'xingzao-reproduction-setup', packageId: id, purpose: 'active',
    selector: { kind: 'installed', expectedIntegrity: enabled.integrity, expectedTreeIntegrity: enabled.treeIntegrity },
  });
  const profile = yaml.parse(await readFile(profilePath, 'utf8'));
  if (!profile.packages.some(item => item.id === id)) profile.packages.push({ id, source: `file:./${directory}`, version: preview.version, enabled: true });
  if (!profile.presets.allowed.includes(preset)) profile.presets.allowed.push(preset);
  await writeFile(profilePath, yaml.stringify(profile));
  console.log(`已安装并启用：${id}（${preset}）`);
}
console.log('四个业务插件已准备好。请按说明停止并重启同一 AGH 实例，使快照生效。');
