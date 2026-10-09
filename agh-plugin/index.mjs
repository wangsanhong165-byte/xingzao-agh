import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const Kind = Symbol.for('TypeBox.Kind')
const TASK_DIR = process.env.PHOTO_CAD_TASK_DIR
const RESULT_FILE = process.env.PHOTO_CAD_RESULT_FILE
const MODEL_API = 'http://127.0.0.1:4317/api/model'
const RENDER_API = 'http://127.0.0.1:4317/api/render'
const MAX_PHOTO_BYTES = 5 * 1024 * 1024
const MAX_RENDER_RESPONSE_BASE64_CHARS = 12 * 1024 * 1024
const PHOTO_NAMES = readNames(process.env.PHOTO_CAD_PHOTO_NAMES)
const SAMPLE_NAMES = readNames(process.env.PHOTO_CAD_SAMPLE_PHOTO_NAMES)
const taskState = { photosRead: new Set(), validatedSpec: null, renderedSpec: null }

function readNames(raw) {
  try {
    const names = JSON.parse(raw || '[]')
    return Array.isArray(names) ? names.filter((name) => typeof name === 'string' && /^photo-\d+\.(?:png|jpg)$/u.test(name)) : []
  } catch {
    return []
  }
}

function schema(properties, required) {
  return {
    [Kind]: 'Object',
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }
}

const string = (maxLength) => ({ [Kind]: 'String', type: 'string', minLength: 1, maxLength })
const number = { [Kind]: 'Number', type: 'number' }
const boolean = { [Kind]: 'Boolean', type: 'boolean' }
const anyObject = { [Kind]: 'Object', type: 'object', properties: {}, required: [], additionalProperties: true }
const textList = { [Kind]: 'Array', type: 'array', items: string(500), maxItems: 20 }
const renderOptions = {
  [Kind]: 'Object',
  type: 'object',
  properties: { lightweight: boolean, minWall: number, preserveMargin: number, densityGPerCm3: number },
  required: [],
  additionalProperties: false,
}

const meta = {
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: 'safe',
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'never',
}

function result(content, structured) {
  return { content, structured }
}

function textResult(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structured: value, ...(isError ? { isError: true } : {}) }
}

function badRequest(message) {
  return textResult({ success: false, error: message }, true)
}

function normalizedSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !['plate', 'bracket', 'box'].includes(spec.type)) return null
  const dimensions = spec.dimensions
  if (!dimensions || ['width', 'depth', 'height', 'wallThickness'].some((key) => !Number.isFinite(dimensions[key]) || dimensions[key] <= 0)) return null
  if (dimensions.width > 500 || dimensions.depth > 500 || dimensions.height > 500 || dimensions.wallThickness < 1) return null
  const holes = spec.holes ?? []
  if (!Array.isArray(holes) || holes.length > 16 || holes.some((hole) => !hole || ['x', 'y', 'diameter'].some((key) => !Number.isFinite(hole[key])) || hole.diameter <= 0)) return null
  if (typeof spec.name !== 'string' || spec.name.length > 120) return null
  return spec
}

function specKey(spec) {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex')
}

function inTaskDir(filename) {
  if (!TASK_DIR || !/^photo-\d+\.(?:png|jpg)$/u.test(filename) || !PHOTO_NAMES.includes(filename)) return null
  const resolved = path.resolve(TASK_DIR, filename)
  if (path.dirname(resolved) !== path.resolve(TASK_DIR)) return null
  return resolved
}

async function readPhoto({ filename }) {
  const fullPath = inTaskDir(filename)
  if (!fullPath) return badRequest('That photo is outside the current task.')
  try {
    const data = await readFile(fullPath)
    if (data.length > MAX_PHOTO_BYTES) return badRequest('The photo exceeds the 5 MiB tool limit.')
    const png = filename.endsWith('.png') && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const jpeg = filename.endsWith('.jpg') && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    if (!png && !jpeg) return badRequest('The file content does not match PNG or JPEG.')
    taskState.photosRead.add(filename)
    const mimeType = png ? 'image/png' : 'image/jpeg'
    return {
      ...result([{ type: 'image', data: data.toString('base64'), mimeType }], { success: true, filename, mimeType, bytes: data.length }),
      isError: false,
    }
  } catch {
    return badRequest('The requested photo could not be read.')
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  })
  let data
  try {
    data = await response.json()
  } catch {
    throw new Error('The local modeling service returned invalid JSON.')
  }
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error.slice(0, 400) : 'The local modeling service rejected the request.')
  return data
}

async function validateGeometry({ spec }) {
  const candidate = normalizedSpec(spec)
  if (!candidate) return badRequest('The proposed geometry is outside the supported spec limits.')
  try {
    const data = await postJson(MODEL_API, { spec: candidate, options: { lightweight: false } })
    const checks = Array.isArray(data.checks) ? data.checks : []
    const success = Array.isArray(data.mesh?.positions) && data.mesh.positions.length >= 9 && data.mesh.positions.every(Number.isFinite) && checks.length > 0 && checks.every((check) => check.status === 'pass')
    if (!success) return badRequest('Geometry validation did not pass every check.')
    taskState.validatedSpec = specKey(candidate)
    taskState.renderedSpec = null
    return textResult({ success: true, spec: candidate, checks: checks.map(({ name, status }) => ({ name, status })), metrics: data.metrics })
  } catch (error) {
    return badRequest(error?.message || 'Geometry validation failed.')
  }
}

async function renderViews({ spec, options = {} }) {
  const candidate = normalizedSpec(spec)
  if (!candidate || taskState.validatedSpec !== specKey(candidate)) return badRequest('Validate this exact spec before rendering comparison views.')
  try {
    const data = await postJson(RENDER_API, { spec: candidate, options })
    if (!Array.isArray(data.views) || data.views.length < 3 || data.views.length > 8) return badRequest('The rendering endpoint did not return the expected orthographic views.')
    if (data.checks?.boundaryEdges !== 0 || data.checks?.nonManifoldEdges !== 0)
      return badRequest(`Blender reported an open or non-manifold mesh (boundaryEdges=${String(data.checks?.boundaryEdges)}, nonManifoldEdges=${String(data.checks?.nonManifoldEdges)}); revise the spec and validate it again.`)
    const content = []
    let totalBase64Chars = 0
    for (const view of data.views) {
      if (!view || typeof view.name !== 'string' || view.mime !== 'image/png' || typeof view.dataBase64 !== 'string' || view.dataBase64.length > 5 * 1024 * 1024) return badRequest('A rendered view was invalid or oversized.')
      totalBase64Chars += view.dataBase64.length
      if (totalBase64Chars > MAX_RENDER_RESPONSE_BASE64_CHARS) return badRequest('The combined Blender views exceed the AGH tool response limit.')
      const bytes = Buffer.from(view.dataBase64, 'base64')
      const validPng = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      if (!validPng || bytes.toString('base64') !== view.dataBase64) return badRequest('A rendered view was not a PNG image.')
      content.push({ type: 'text', text: `Rendered view: ${view.name}` }, { type: 'image', data: view.dataBase64, mimeType: 'image/png' })
    }
    taskState.renderedSpec = specKey(candidate)
    return result(content, { success: true, viewCount: data.views.length, checks: data.checks, views: data.views.map((view) => ({ name: view.name, mime: view.mime })) })
  } catch (error) {
    return badRequest(error?.message || 'The local renderer failed.')
  }
}

async function submitResult({ spec, assumptions, questions, confidence }) {
  const candidate = normalizedSpec(spec)
  if (!candidate || taskState.validatedSpec !== specKey(candidate) || taskState.renderedSpec !== specKey(candidate))
    return badRequest('Read the selected photos, validate this exact spec, and render comparison views before submitting.')
  if (SAMPLE_NAMES.some((name) => !taskState.photosRead.has(name))) return badRequest('Read every default sampled photo before submitting.')
  if (!Array.isArray(assumptions) || assumptions.length > 20 || assumptions.some((value) => typeof value !== 'string' || value.length > 500) || !Array.isArray(questions) || questions.length > 20 || questions.some((value) => typeof value !== 'string' || value.length > 500) || typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    return badRequest('The structured result fields are invalid.')
  if (!RESULT_FILE || !TASK_DIR || path.dirname(path.resolve(RESULT_FILE)) !== path.resolve(TASK_DIR))
    return badRequest('The isolated task result path is unavailable.')
  try {
    const normalized = {
      spec: candidate,
      assumptions: assumptions.slice(0, 20).map((value) => String(value).slice(0, 500)),
      questions: questions.slice(0, 20).map((value) => String(value).slice(0, 500)),
      confidence,
    }
    const serialized = JSON.stringify(normalized)
    try {
      await writeFile(RESULT_FILE, serialized, { flag: 'wx', mode: 0o600 })
    } catch {
      if ((await readFile(RESULT_FILE, 'utf8')) !== serialized) throw new Error('result conflict')
    }
    return textResult({ success: true, submitted: true, spec: candidate })
  } catch {
    return badRequest('The structured result could not be committed to the isolated task file.')
  }
}

export const photoCadTools = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()
    agnes.registerTool({
      name: 'photo_cad_read_photo',
      description: 'Read one PNG or JPEG photo attached to this isolated photo-cad task. The returned image is provided to the model as native image content.',
      parameters: schema({ filename: string(64) }, ['filename']),
      meta: { ...meta, isReadOnly: true, isOpenWorld: true, isConcurrencySafe: true },
      execute: readPhoto,
    })
    agnes.registerTool({
      name: 'photo_cad_validate_geometry',
      description: 'Validate a supported plate, bracket, or box spec by generating a real local CAD mesh through Photo CAD.',
      parameters: schema({ spec: anyObject }, ['spec']),
      meta: { ...meta, isConcurrencySafe: true },
      execute: validateGeometry,
    })
    agnes.registerTool({
      name: 'photo_cad_render_views',
      description: 'Render real orthographic Blender views of the validated candidate through the local Photo CAD render endpoint. Use the returned images to compare the candidate against uploaded photos.',
      parameters: schema({ spec: anyObject, options: renderOptions }, ['spec']),
      meta: { ...meta, isConcurrencySafe: true },
      execute: renderViews,
    })
    agnes.registerTool({
      name: 'photo_cad_submit_result',
      description: 'Commit the final structured modeling result after reading sampled photos, validating the exact spec, and comparing rendered orthographic views.',
      parameters: schema({ spec: anyObject, assumptions: textList, questions: textList, confidence: number }, ['spec', 'assumptions', 'questions', 'confidence']),
      meta: { ...meta, isConcurrencySafe: false, replay: 'idempotent' },
      execute: submitResult,
    })
  },
}
