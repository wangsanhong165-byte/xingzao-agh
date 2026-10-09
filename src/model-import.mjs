import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const importRoot = path.join(projectRoot, 'data', 'import-jobs')
const inspectorPath = path.join(projectRoot, 'tools', 'reconstruction', 'inspect_mesh.py')
const DEFAULT_PYTHON = path.join(projectRoot, 'data', 'reconstruction', 'env-torch-readonly', 'Scripts', 'python.exe')
const MAX_BYTES = 25 * 1024 * 1024
const MAX_TRIANGLES = 250_000
const MAX_PARTS = 128
const MAX_BASE64_CHARS = Math.ceil(MAX_BYTES / 3) * 4
const MAX_GLB_JSON_NODES = 100_000
const MAX_GLB_JSON_DEPTH = 64
const DATA_URI_MIMES = new Set([
  'application/octet-stream', 'application/gltf-buffer',
  'image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/ktx2',
])

export class ModelImportError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ModelImportError'
    this.code = code
  }
}

function reject(code, message) {
  throw new ModelImportError(code, message)
}

function safeNameAndFormat(name, mime) {
  if (
    typeof name !== 'string' ||
    name.length < 1 || name.length > 200 ||
    /[\\/\x00-\x1f\x7f]/u.test(name) ||
    name === '.' || name === '..'
  ) reject('IMPORT_NAME_INVALID', '模型文件名无效')
  if (typeof mime !== 'string' || mime.length > 128 || mime !== mime.trim())
    reject('IMPORT_MIME_UNSUPPORTED', '模型MIME类型不支持')
  const extension = path.posix.extname(name).toLowerCase()
  const declaredMime = mime.toLowerCase().split(';', 1)[0]
  const generic = declaredMime === 'application/octet-stream'
  if (extension === '.stl' && (generic || ['model/stl', 'application/sla', 'application/vnd.ms-pki.stl'].includes(declaredMime)))
    return { format: 'stl', mime: declaredMime, inputFileName: 'input.stl' }
  if (extension === '.glb' && (generic || ['model/gltf-binary', 'model/glb'].includes(declaredMime)))
    return { format: 'glb', mime: declaredMime, inputFileName: 'input.glb' }
  reject('IMPORT_FORMAT_UNSUPPORTED', '仅支持STL和GLB网格文件')
}

function checkedPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    reject('IMPORT_INPUT_INVALID', '缺少模型导入输入')
  const file = safeNameAndFormat(payload.name, payload.mime)
  if (
    typeof payload.targetLongestEdgeMm !== 'number' ||
    !Number.isFinite(payload.targetLongestEdgeMm) ||
    payload.targetLongestEdgeMm < 1 || payload.targetLongestEdgeMm > 180
  ) reject('IMPORT_INVALID_SCALE', '目标最长边必须由用户指定为1～180mm')
  if (!['mm', 'target-scale'].includes(payload.sourceUnits))
    reject('IMPORT_UNITS_INVALID', 'sourceUnits必须是mm或target-scale')
  const base64 = payload.dataBase64
  if (typeof base64 !== 'string' || base64.length === 0)
    reject('IMPORT_BYTES_INVALID', '模型Base64内容为空或无效')
  if (base64.length > MAX_BASE64_CHARS)
    reject('IMPORT_BYTES_LIMIT', '模型文件超过25MiB限制')
  if (base64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64))
    reject('IMPORT_BYTES_INVALID', '模型Base64内容为空或无效')
  const bytes = Buffer.from(base64, 'base64')
  if (
    bytes.length === 0 || bytes.length > MAX_BYTES ||
    bytes.toString('base64').replace(/=+$/u, '') !== base64.replace(/=+$/u, '')
  ) reject(bytes.length > MAX_BYTES ? 'IMPORT_BYTES_LIMIT' : 'IMPORT_BYTES_INVALID', '模型Base64内容为空、无效或超过25MiB')
  return { ...file, name: payload.name, sourceUnits: payload.sourceUnits, targetLongestEdgeMm: payload.targetLongestEdgeMm, bytes }
}

function checkedDataUri(uri) {
  if (uri.length > MAX_BYTES * 4 / 3 + 256) reject('IMPORT_GLB_DATA_URI_LIMIT', 'GLB内嵌数据超过大小限制')
  const comma = uri.indexOf(',')
  const header = comma >= 0 ? uri.slice(0, comma) : ''
  const data = comma >= 0 ? uri.slice(comma + 1) : ''
  if (!header.startsWith('data:') || !header.endsWith(';base64'))
    reject('IMPORT_GLB_DATA_URI_INVALID', 'GLB data URI格式无效')
  if (!DATA_URI_MIMES.has(header.slice(5, -7).toLowerCase()))
    reject('IMPORT_GLB_DATA_URI_INVALID', 'GLB data URI媒体类型不支持')
  if (data.length > MAX_BASE64_CHARS || data.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data))
    reject('IMPORT_GLB_DATA_URI_INVALID', 'GLB data URI数据无效或超过大小限制')
  if (Buffer.from(data, 'base64').toString('base64').replace(/=+$/u, '') !== data.replace(/=+$/u, ''))
    reject('IMPORT_GLB_DATA_URI_INVALID', 'GLB data URI编码无效')
}

function accessorCount(accessors, index) {
  if (!Number.isInteger(index) || index < 0 || index >= accessors.length)
    reject('IMPORT_GLB_INVALID', 'GLB网格索引无效')
  const count = accessors[index]?.count
  if (!Number.isSafeInteger(count) || count < 0)
    reject('IMPORT_GLB_INVALID', 'GLB网格索引无效')
  return count
}

function estimateGlbComplexity(gltf) {
  const meshes = gltf.meshes ?? []
  const nodes = gltf.nodes ?? []
  const accessors = gltf.accessors ?? []
  if (!Array.isArray(meshes) || !Array.isArray(nodes) || !Array.isArray(accessors))
    reject('IMPORT_GLB_INVALID', 'GLB结构无效')
  if (meshes.length > MAX_PARTS || nodes.length > MAX_GLB_JSON_NODES)
    reject('IMPORT_PART_LIMIT', 'GLB场景部件超过限制')

  const meshTriangles = []
  const meshParts = []
  for (const mesh of meshes) {
    if (!mesh || typeof mesh !== 'object' || !Array.isArray(mesh.primitives) || mesh.primitives.length === 0)
      reject('IMPORT_GLB_INVALID', 'GLB网格结构无效')
    let triangles = 0
    for (const primitive of mesh.primitives) {
      if (!primitive || typeof primitive !== 'object' || (primitive.mode ?? 4) !== 4)
        reject('IMPORT_GLB_PRIMITIVE_UNSUPPORTED', '仅支持GLB三角形网格')
      if (primitive.extensions?.KHR_draco_mesh_compression)
        reject('IMPORT_GLB_PRIMITIVE_UNSUPPORTED', '压缩GLB网格暂不支持')
      const count = primitive.indices === undefined
        ? accessorCount(accessors, primitive.attributes?.POSITION)
        : accessorCount(accessors, primitive.indices)
      if (count < 3 || count % 3 !== 0) reject('IMPORT_GLB_INVALID', 'GLB三角形索引无效')
      triangles += count / 3
    }
    meshTriangles.push(triangles)
    meshParts.push(mesh.primitives.length)
  }

  const references = []
  if (nodes.length > 0) {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') reject('IMPORT_GLB_INVALID', 'GLB节点无效')
      if (node.mesh !== undefined) {
        if (!Number.isInteger(node.mesh) || node.mesh < 0 || node.mesh >= meshes.length)
          reject('IMPORT_GLB_INVALID', 'GLB节点网格索引无效')
        references.push(node.mesh)
      }
      if (node.extensions?.EXT_mesh_gpu_instancing)
        reject('IMPORT_GLB_INSTANCING_UNSUPPORTED', 'GLB实例化网格暂不支持')
    }
  } else references.push(...meshes.map((_, index) => index))

  const triangles = references.reduce((sum, index) => sum + meshTriangles[index], 0)
  const parts = references.reduce((sum, index) => sum + meshParts[index], 0)
  if (triangles > MAX_TRIANGLES) reject('IMPORT_TRIANGLE_LIMIT', '模型三角面超过250000限制')
  if (parts > MAX_PARTS) reject('IMPORT_PART_LIMIT', '模型场景部件超过128限制')
}

function preflightGlb(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF')
    reject('IMPORT_GLB_INVALID', 'GLB头部无效')
  const version = bytes.readUInt32LE(4)
  const totalLength = bytes.readUInt32LE(8)
  if (version !== 2 || totalLength !== bytes.length)
    reject('IMPORT_GLB_INVALID', '仅支持长度正确的GLB 2.0文件')

  let offset = 12
  let chunkIndex = 0
  let gltf
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) reject('IMPORT_GLB_INVALID', 'GLB区块头无效')
    const chunkLength = bytes.readUInt32LE(offset)
    const chunkType = bytes.readUInt32LE(offset + 4)
    offset += 8
    const end = offset + chunkLength
    if (chunkLength === 0 || chunkLength % 4 !== 0 || end > bytes.length)
      reject('IMPORT_GLB_INVALID', 'GLB区块长度无效')
    if (chunkIndex === 0 && chunkType === 0x4e4f534a) {
      let text
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, end)).replace(/[\x00 \t\r\n]+$/u, '')
        gltf = JSON.parse(text)
      } catch {
        reject('IMPORT_GLB_INVALID', 'GLB JSON区块无效')
      }
    } else if (chunkIndex === 1 && chunkType === 0x004e4942) {
      // Embedded binary chunk; the parser later receives the complete payload as BytesIO.
    } else reject('IMPORT_GLB_CHUNK_UNSUPPORTED', 'GLB包含不支持的区块')
    chunkIndex++
    offset = end
  }
  if (!gltf || chunkIndex > 2 || offset !== bytes.length || gltf.asset?.version !== '2.0')
    reject('IMPORT_GLB_INVALID', 'GLB 2.0 JSON结构无效')

  const stack = [{ value: gltf, depth: 0 }]
  let nodes = 0
  while (stack.length) {
    const { value, depth } = stack.pop()
    nodes++
    if (nodes > MAX_GLB_JSON_NODES || depth > MAX_GLB_JSON_DEPTH)
      reject('IMPORT_GLB_JSON_LIMIT', 'GLB JSON复杂度超过限制')
    if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, depth: depth + 1 })
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'uri') {
          if (typeof child !== 'string') reject('IMPORT_GLB_URI_INVALID', 'GLB资源URI无效')
          if (child.startsWith('data:')) checkedDataUri(child)
          else reject('IMPORT_GLB_EXTERNAL_URI', 'GLB禁止访问外部资源URI')
        }
        stack.push({ value: child, depth: depth + 1 })
      }
    }
  }
  estimateGlbComplexity(gltf)
}

function preflightStl(bytes) {
  if (bytes.length < 15) reject('IMPORT_STL_INVALID', 'STL文件格式无效')
  if (bytes.length >= 84) {
    const triangles = bytes.readUInt32LE(80)
    if (triangles > MAX_TRIANGLES) reject('IMPORT_TRIANGLE_LIMIT', '模型三角面超过250000限制')
    if (84 + triangles * 50 === bytes.length) {
      if (triangles === 0) reject('IMPORT_STL_EMPTY', 'STL没有三角面')
      return triangles
    }
  }
  let text
  try {
    text = new TextDecoder('ascii', { fatal: true }).decode(bytes)
  } catch {
    reject('IMPORT_STL_INVALID', 'STL二进制长度无效')
  }
  if (!/^\s*solid(?:\s|$)/iu.test(text) || !/\bendsolid\b/iu.test(text))
    reject('IMPORT_STL_INVALID', 'STL文件格式无效')
  const triangles = [...text.matchAll(/\bfacet\s+normal\b/giu)].length
  if (triangles === 0) reject('IMPORT_STL_EMPTY', 'STL没有三角面')
  if (triangles > MAX_TRIANGLES) reject('IMPORT_TRIANGLE_LIMIT', '模型三角面超过250000限制')
  return triangles
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function ensureWithin(root, target) {
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    reject('IMPORT_PATH_INVALID', '导入目录不在项目数据目录内')
}

async function mkdirNoSymlink(directory) {
  await mkdir(directory, { recursive: true })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) reject('IMPORT_PATH_INVALID', '导入目录无效')
}

function sanitizedEnvironment() {
  const env = { PYTHONNOUSERSITE: '1' }
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key]
  }
  return env
}

function pythonErrorCode(error) {
  const text = String(error?.stderr ?? '').trim().split(/\r?\n/u).reverse()
  for (const line of text) {
    try {
      const parsed = JSON.parse(line)
      if (typeof parsed.code === 'string' && /^IMPORT_[A-Z_]+$/u.test(parsed.code)) return parsed.code
    } catch {}
  }
  return error?.code === 'ENOENT' ? 'IMPORT_PYTHON_NOT_FOUND' : error?.code === 'ETIMEDOUT' || error?.killed
    ? 'IMPORT_INSPECTION_TIMEOUT'
    : 'IMPORT_INSPECTION_FAILED'
}

export async function inspectModelUpload(payload, options = {}) {
  const input = checkedPayload(payload)
  if (input.format === 'glb') preflightGlb(input.bytes)
  else preflightStl(input.bytes)

  const inputSha256 = hash(input.bytes)
  const identity = JSON.stringify({
    version: 2,
    inputSha256,
    format: input.format,
    sourceUnits: input.sourceUnits,
    targetLongestEdgeMm: input.targetLongestEdgeMm,
    normalizationStrategy: 'center-xy-z0-v1',
  })
  const baseCandidateId = hash(Buffer.from(identity))
  const verificationNonce = options.verificationNonce
  if (verificationNonce !== undefined && (typeof verificationNonce !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(verificationNonce)))
    reject('IMPORT_VERIFICATION_NONCE_INVALID', '内部复查标识无效')
  const candidateId = verificationNonce === undefined ? baseCandidateId : hash(Buffer.from(`source-recheck-v1:${baseCandidateId}:${verificationNonce}`))
  const jobDir = path.join(importRoot, candidateId)
  ensureWithin(importRoot, jobDir)
  const dataRoot = path.join(projectRoot, 'data')
  await mkdir(dataRoot, { recursive: true })
  const dataInfo = await lstat(dataRoot)
  if (!dataInfo.isDirectory() || dataInfo.isSymbolicLink())
    reject('IMPORT_PATH_INVALID', '项目数据目录无效')
  await mkdirNoSymlink(importRoot)
  await mkdirNoSymlink(jobDir)
  const inputPath = path.join(jobDir, input.inputFileName)
  const summaryPath = path.join(jobDir, 'summary.json')
  const normalizedStlPath = path.join(jobDir, 'normalized.stl')
  for (const target of [inputPath, summaryPath, normalizedStlPath]) ensureWithin(importRoot, target)

  try {
    await writeFile(inputPath, input.bytes, { flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const inputInfo = await lstat(inputPath).catch(() => null)
    if (!inputInfo?.isFile() || inputInfo.isSymbolicLink())
      reject('IMPORT_PATH_INVALID', '已保存的输入路径不是普通文件')
    const existing = await readFile(inputPath)
    if (hash(existing) !== inputSha256) reject('IMPORT_STORED_INPUT_MISMATCH', '已保存的输入SHA不匹配')
  }
  const storedInput = await readFile(inputPath)
  if (hash(storedInput) !== inputSha256) reject('IMPORT_STORED_INPUT_MISMATCH', '保存后的输入SHA不匹配')

  const pythonPath = options.pythonPath ?? process.env.PHOTO_CAD_MESH_PYTHON ?? DEFAULT_PYTHON
  try {
    await execFile(pythonPath, [
      inspectorPath,
      '--input', inputPath,
      '--summary', summaryPath,
      '--normalized-stl', normalizedStlPath,
      '--candidate-id', candidateId,
      '--input-sha256', inputSha256,
      '--format', input.format,
      '--source-units', input.sourceUnits,
      '--target-longest-edge-mm', String(input.targetLongestEdgeMm),
    ], {
      cwd: projectRoot,
      env: sanitizedEnvironment(),
      windowsHide: true,
      timeout: options.timeoutMs ?? 60_000,
      killSignal: 'SIGTERM',
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    })
  } catch (error) {
    const code = pythonErrorCode(error)
    const messages = {
      IMPORT_PYTHON_NOT_FOUND: '隔离的网格检查Python环境不可用',
      IMPORT_INSPECTION_TIMEOUT: '网格检查超时',
      IMPORT_TRIANGLE_LIMIT: '模型三角面超过250000限制',
      IMPORT_PART_LIMIT: '模型场景部件超过128限制',
      IMPORT_GLB_EXTERNAL_URI: 'GLB禁止访问外部资源URI',
    }
    reject(code, messages[code] ?? '网格检查失败')
  }

  let summary
  try {
    summary = JSON.parse(await readFile(summaryPath, 'utf8'))
  } catch {
    reject('IMPORT_SUMMARY_INVALID', '检查器没有写入有效摘要')
  }
  if (
    summary?.candidateId !== candidateId || summary?.inputSha256 !== inputSha256 ||
    summary?.format !== input.format || summary?.sourceUnits !== input.sourceUnits ||
    summary?.targetLongestEdgeMm !== input.targetLongestEdgeMm ||
    summary?.normalizationStrategy !== 'center-xy-z0-v1' ||
    summary?.normalizedStlFile !== 'normalized.stl' ||
    typeof summary?.geometryChecksPassed !== 'boolean' ||
    summary?.printable !== summary.geometryChecksPassed ||
    summary?.validationScope?.kind !== 'geometry-only' ||
    !Array.isArray(summary?.normalizationTransform) ||
    summary.normalizationTransform.length !== 4 ||
    summary.normalizationTransform.some((row) => !Array.isArray(row) || row.length !== 4 || row.some((n) => !Number.isFinite(n)))
  ) reject('IMPORT_SUMMARY_MISMATCH', '模型检查摘要与实际输入不一致')
  const normalizedStl = await readFile(normalizedStlPath).catch(() => null)
  if (!normalizedStl || hash(normalizedStl) !== summary.normalizedStlSha256)
    reject('IMPORT_NORMALIZED_STL_HASH_MISMATCH', '标准化STL文件SHA校验失败')

  const result = {
    ...summary,
    name: input.name,
    mime: input.mime,
    normalizedStlPath: path.posix.join('data', 'import-jobs', candidateId, 'normalized.stl'),
    ...(verificationNonce === undefined ? {} : { verificationOfCandidateId: baseCandidateId }),
  }
  await writeFile(summaryPath, `${JSON.stringify(result, null, 2)}\n`)
  return result
}

export const modelImportInternals = Object.freeze({
  maxBytes: MAX_BYTES,
  maxTriangles: MAX_TRIANGLES,
  maxParts: MAX_PARTS,
  defaultPython: DEFAULT_PYTHON,
  importRoot,
  inspectGlbJson: preflightGlb,
  inspectStlBytes: preflightStl,
})
