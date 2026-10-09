const Kind = Symbol.for('TypeBox.Kind')
const id = { [Kind]: 'String', type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]{1,128}$' }
const object = (properties = {}, required = []) => ({ [Kind]: 'Object', type: 'object', properties, required, additionalProperties: false })
const num = (minimum, maximum) => ({ [Kind]: 'Number', type: 'number', minimum, maximum })
const empty = object()
const candidate = object({ candidateId: id }, ['candidateId'])
const options = object({ options: object({
  steps: num(5, 50), resolution: { [Kind]: 'Number', type: 'number', enum: [128, 256] },
  numChunks: { [Kind]: 'Number', type: 'number', enum: [4000, 8000, 20000] }, seed: num(0, 4294967295),
}) }, ['options'])

let boundJob = null
let calls = 0
let generated = 0
let inspected = false
const generatedCandidates = new Set()
const validatedCandidates = new Set()
const slicedCandidates = new Set()
const MAX_CALLS = 12
const TOOL_TIMEOUT_MS = 330_000
const DEFAULT_NATIVE_TIMEOUT_MS = 120_000
const DEADLINE_MARGIN_MS = 1_000
const specs = [
  ['mesh_inspect', 'inspect', empty],
  ['mesh_generate', 'generate', options],
  ['mesh_validate', 'validate', candidate],
  ['mesh_slice', 'slice', candidate],
  ['mesh_submit', 'submit', candidate],
]

async function callTool(path, args, toolContext) {
  const jobId = process.env.PRINT_TASK_JOB_ID
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(jobId ?? '')) throw new Error('PRINT_TASK_JOB_ID is missing or invalid')
  const token = process.env.PRINT_TASK_JOB_ACCESS
  if (typeof token !== 'string' || token.length < 16 || token.length > 512 || /\s/u.test(token)) throw new Error('PRINT_TASK_JOB_ACCESS is missing or invalid')
  if (boundJob !== null && boundJob !== jobId) throw new Error('this reconstruction AGH session is bound to a different job')
  boundJob = jobId
  if (calls >= MAX_CALLS) throw new Error('reconstruction tool-call budget exhausted')
  if (path !== 'inspect' && !inspected) throw new Error('mesh_inspect must be called before reconstruction tools')
  if (path === 'generate' && generated >= 2) throw new Error('maximum of two generated reconstruction candidates reached')
  if (path === 'validate' && !generatedCandidates.has(args.candidateId)) throw new Error('mesh_validate requires a candidate generated in this session')
  if (path === 'slice' && !validatedCandidates.has(args.candidateId)) throw new Error('mesh_slice requires a validated candidate')
  if (path === 'submit' && !slicedCandidates.has(args.candidateId)) throw new Error('mesh_submit requires a candidate sliced in this session')
  const configured = process.env.PRINT_TASK_SERVICE_URL || 'http://127.0.0.1:4337'
  const service = new URL(configured)
  if (service.protocol !== 'http:' || service.hostname !== '127.0.0.1' || service.port !== '4337' || service.pathname !== '/')
    throw new Error('reconstruction service must be http://127.0.0.1:4337')
  calls += 1
  if (path === 'generate') generated += 1
  const response = await fetch(new URL(`/api/reconstruction/tool/${path}`, service), {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-print-task-access': token },
    body: JSON.stringify({ jobId, ...(args.candidateId ? { candidateId: args.candidateId } : {}), ...(args.options ? { options: args.options } : {}) }),
    signal: requestSignal(toolContext),
  })
  let result
  try { result = await response.json() } catch { throw new Error(`reconstruction service returned invalid JSON (${response.status})`) }
  if (!response.ok || result?.success !== true) {
    const code = typeof result?.code === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(result.code) ? result.code : undefined
    const reason = typeof result?.reason === 'string' ? result.reason.slice(0, 600) : code ?? `HTTP ${response.status}`
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, ...(code ? { code } : {}), reason, checks: result?.checks, metrics: result?.metrics, slice: result?.slice }) }], structured: { ...result, success: false } }
  }
  if (path === 'inspect') inspected = true
  else if (path === 'generate') {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(result.candidateId ?? '')) throw new Error('mesh_generate response omitted a valid candidateId')
    generatedCandidates.add(result.candidateId)
  } else if (path === 'validate' && result.success === true && result.valid === true) validatedCandidates.add(args.candidateId)
  else if (path === 'slice' && result.success === true && result.slice?.mode === 'actual-slicer' && result.slice.execution?.mode === 'actual-slicer') slicedCandidates.add(args.candidateId)
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structured: result }
}

function requestSignal(toolContext) {
  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs(toolContext))
  return toolContext?.signal instanceof AbortSignal ? AbortSignal.any([toolContext.signal, timeoutSignal]) : timeoutSignal
}
function requestTimeoutMs(toolContext) {
  const nativeLimit = Number.isSafeInteger(toolContext?.timeoutMs) && toolContext.timeoutMs > 0
    ? toolContext.timeoutMs
    : DEFAULT_NATIVE_TIMEOUT_MS
  return Math.max(1_000, Math.min(TOOL_TIMEOUT_MS, nativeLimit - DEADLINE_MARGIN_MS))
}

function makeTool(name, path, parameters) {
  return {
    name, path, parameters,
    inject: ['extension'],
    apply(ctx) {
      ctx.extension().registerTool({
        name,
        description: descriptions[name],
        parameters,
        meta: { isReadOnly: path === 'inspect', isDestructive: false, isConcurrencySafe: false, isOpenWorld: false,
          replay: path === 'inspect' ? 'safe' : 'never', costHint: undefined, deferLoading: false, requiresApproval: 'never' },
        async execute(args, toolContext) { return callTool(path, args, toolContext) },
      })
    },
  }
}
const descriptions = {
  mesh_inspect: 'Inspect the three labeled input views and reconstruction constraints. Call first.',
  mesh_generate: 'Generate one candidate locally from the three views with bounded Hunyuan3D-2mv settings; maximum two candidates per job.',
  mesh_validate: 'Independently inspect the generated mesh geometry and dimensions for this candidate.',
  mesh_slice: 'Run the actual configured slicer for this validated candidate and return baseline metrics.',
  mesh_submit: 'Submit this candidate only after successful geometry validation and actual slicing.',
}
export const meshInspectTool = makeTool('mesh_inspect', 'inspect', empty)
export const meshGenerateTool = makeTool('mesh_generate', 'generate', options)
export const meshValidateTool = makeTool('mesh_validate', 'validate', candidate)
export const meshSliceTool = makeTool('mesh_slice', 'slice', candidate)
export const meshSubmitTool = makeTool('mesh_submit', 'submit', candidate)
export const reconstructionTools = Object.freeze([meshInspectTool, meshGenerateTool, meshValidateTool, meshSliceTool, meshSubmitTool])
export const reconstructionPluginInternals = Object.freeze({ TOOL_TIMEOUT_MS, requestTimeoutMs })
export const presets = Object.freeze({
  'reconstruction-tools': Object.freeze({
    name: 'reconstruction-tools',
    extends: 'standard',
    tools: Object.freeze({ timeouts: Object.freeze({ mesh_generate: TOOL_TIMEOUT_MS }) }),
  }),
})
