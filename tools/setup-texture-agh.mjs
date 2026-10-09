import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { printAghInternals } from '../src/print-agh.mjs'

const PACKAGE_ID = '@photo-cad/texture-tools'
const PACKAGE_VERSION = '1.0.0'
const PRESET_ID = 'texture-tools'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(process.env.PHOTO_CAD_AGH_SOURCE || join(root, 'data', 'agh-source'))
const home = printAghInternals.reconstructionHome(process.env)
const profileDir = join(home, 'profiles', 'local-dev')
const require = createRequire(join(sourceRoot, 'packages', 'package-manager', 'package.json'))
const yaml = require('yaml')

await import(pathToFileURL(join(sourceRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href)
const { createPackageManager } = await import(pathToFileURL(join(sourceRoot, 'packages', 'package-manager', 'src', 'manager.ts')).href)
const { parseSource } = await import(pathToFileURL(join(sourceRoot, 'packages', 'package-manager', 'src', 'sources.ts')).href)
const { capabilityHash } = await import(pathToFileURL(join(sourceRoot, 'packages', 'package-manager', 'src', 'integrity.ts')).href)
const { activeRuntimePinId } = await import(pathToFileURL(join(sourceRoot, 'packages', 'package-manager', 'src', 'package-plugin-loader.ts')).href)
const lock = JSON.parse(await readFile(join(profileDir, 'agnes-lock.json'), 'utf8'))
const manager = createPackageManager({ dataDir: join(home, 'data'), agnesVersion: lock.generatedBy.agnesVersion, cwd: root })
const source = parseSource('file:./texture-agh-plugin')
const preview = await manager.inspect(profileDir, source)
console.log(JSON.stringify({ id: preview.id, version: preview.version, integrity: preview.integrity, capabilityHash: preview.capabilityHash, blockers: preview.blockers, mode: 'official-package-manager-inspect' }))

if (process.argv.includes('--install')) {
  const index = process.argv.indexOf('--expected-integrity')
  const expectedIntegrity = index >= 0 ? process.argv[index + 1] : undefined
  if (expectedIntegrity !== preview.integrity || preview.id !== PACKAGE_ID || preview.version !== PACKAGE_VERSION || preview.blockers.length)
    throw new Error('TEXTURE_INSTALL_PREVIEW_MISMATCH')
  const existing = lock.packages?.[PACKAGE_ID]
  if (existing && existing.integrity !== preview.integrity) throw new Error('TEXTURE_INSTALLED_SOURCE_DIFFERS')
  const installed = existing ?? await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
  await manager.trust(profileDir, PACKAGE_ID, { integrity: installed.integrity, capabilityHash: capabilityHash(installed) })
  const enabled = await manager.setEnabled(profileDir, PACKAGE_ID, true, { expectedInstalledIntegrity: installed.integrity })
  const pin = await manager.pinRuntimeSnapshot(profileDir, {
    pinId: activeRuntimePinId({ packageId: PACKAGE_ID, integrity: enabled.integrity }),
    operationId: 'photo-cad-texture-setup-v1', packageId: PACKAGE_ID, purpose: 'active',
    selector: { kind: 'installed', expectedIntegrity: enabled.integrity, expectedTreeIntegrity: enabled.treeIntegrity },
  })
  const yamlFile = join(profileDir, 'profile.yaml')
  const profile = yaml.parse(await readFile(yamlFile, 'utf8'))
  if (!Array.isArray(profile.packages) || !profile.presets || !Array.isArray(profile.presets.allowed)) throw new Error('TEXTURE_PROFILE_SHAPE_INVALID')
  if (!profile.packages.some(item => item.id === PACKAGE_ID))
    profile.packages.push({ id: PACKAGE_ID, source: 'file:./texture-agh-plugin', version: PACKAGE_VERSION, enabled: true })
  if (!profile.presets.allowed.includes(PRESET_ID)) profile.presets.allowed.push(PRESET_ID)
  await writeFile(yamlFile, yaml.stringify(profile))
  console.log(JSON.stringify({ id: PACKAGE_ID, integrity: enabled.integrity, trusted: Boolean(enabled.state.trusted), enabled: enabled.state.enabled === true,
    activeSnapshot: pin.snapshot.snapshotId, profileDefault: profile.presets.default, mode: 'official-install-trust-enable-pin-with-explicit-profile-reference' }))
}
