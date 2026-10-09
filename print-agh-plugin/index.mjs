const Kind = Symbol.for('TypeBox.Kind')
const objectSchema = (properties = {}, required = []) => ({
  [Kind]: 'Object',
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const stringSchema = { [Kind]: 'String', type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]{1,128}$' }
const numberSchema = (minimum, maximum) => ({
  [Kind]: 'Number', type: 'number', minimum, maximum,
})

const emptyParameters = objectSchema()
const candidateParameters = objectSchema({ candidateId: stringSchema }, ['candidateId'])
const optionsParameters = objectSchema({
  options: objectSchema({
    enhance: { [Kind]: 'Boolean', type: 'boolean' },
    reliefHeight: numberSchema(0.2, 3),
    minFeatureWidth: numberSchema(0.4, 3),
  }, ['enhance']),
}, ['options'])

let boundJobId = null
let callsUsed = 0
const MAX_TOOL_CALLS = 12
const builtCandidates = new Set()
const slicedCandidates = new Set()
const verifiedCandidates = new Set()

const routes = Object.freeze({
  detail_inspect: { path: 'inspect', parameters: emptyParameters },
  detail_build: { path: 'build', parameters: optionsParameters },
  detail_slice: { path: 'slice', parameters: candidateParameters },
  detail_verify: { path: 'verify', parameters: candidateParameters },
  detail_submit: { path: 'submit', parameters: candidateParameters },
})

async function requestTool(path, args) {
  const jobId = process.env.PRINT_TASK_JOB_ID
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId ?? '')) throw new Error('PRINT_TASK_JOB_ID is missing or invalid')
  const accessToken = process.env.PRINT_TASK_JOB_ACCESS
  if (typeof accessToken !== 'string' || accessToken.length < 16 || accessToken.length > 512 || /\s/.test(accessToken))
    throw new Error('PRINT_TASK_JOB_ACCESS is missing or invalid')
  if (boundJobId !== null && boundJobId !== jobId) throw new Error('this AGH session is already bound to a different print job')
  boundJobId = jobId
  if (callsUsed >= MAX_TOOL_CALLS) throw new Error('print task tool-call budget exhausted')
  callsUsed += 1
  if (path === 'slice' && !builtCandidates.has(args.candidateId)) throw new Error('slice requires a candidate created by detail_build in this session')
  if (path === 'verify' && !slicedCandidates.has(args.candidateId)) throw new Error('verify requires a successful detail_slice for this candidate')
  if (path === 'submit' && !verifiedCandidates.has(args.candidateId)) throw new Error('submit requires successful detail_verify for this candidate')
  const configured = process.env.PRINT_TASK_SERVICE_URL || 'http://127.0.0.1:4337'
  const service = new URL(configured)
  if (service.protocol !== 'http:' || service.hostname !== '127.0.0.1' || service.port !== '4337' || service.pathname !== '/')
    throw new Error('print service must be the local 127.0.0.1:4337 endpoint')
  const body = { jobId, ...(args.candidateId ? { candidateId: args.candidateId } : {}), ...(args.options ? { options: args.options } : {}) }
  const response = await fetch(new URL(`/api/print/tool/${path}`, service), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-print-task-access': accessToken },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  })
  let result
  try { result = await response.json() } catch { throw new Error(`print service returned invalid JSON (${response.status})`) }
  if (!response.ok || result?.success !== true) {
    const reason = typeof result?.reason === 'string' ? result.reason.slice(0, 600) : `HTTP ${response.status}`
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, reason, checks: result?.checks, metrics: result?.metrics, nextActions: result?.nextActions }) }], structured: { ...result, success: false } }
  }
  if (path === 'build') {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(result.candidateId ?? ''))
      throw new Error('print service build response omitted a valid candidateId')
    builtCandidates.add(result.candidateId)
  } else if (path === 'slice') slicedCandidates.add(args.candidateId)
  else if (path === 'verify') verifiedCandidates.add(args.candidateId)
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structured: result }
}

function makeTool(name, description, parameters, path) {
  const meta = {
    isReadOnly: path === 'inspect',
    isDestructive: false,
    isConcurrencySafe: false,
    isOpenWorld: false,
    replay: path === 'inspect' ? 'safe' : path === 'verify' ? 'idempotent' : 'never',
    costHint: undefined,
    deferLoading: false,
    requiresApproval: 'never',
  }
  return {
    inject: ['extension'],
    apply(ctx) {
      ctx.extension().registerTool({
        name,
        description,
        parameters,
        meta,
        async execute(args) { return requestTool(path, args) },
      })
    },
  }
}

export const detailInspectTool = makeTool(
  'detail_inspect',
  'Inspect the current print-detail job and its source measurements, constraints, ROI, and baseline candidate. Call before building.',
  emptyParameters,
  routes.detail_inspect.path,
)
export const detailBuildTool = makeTool(
  'detail_build',
  'Create a server-bound raised-geometry candidate from the job using bounded relief options. Use only the returned candidateId for later tools.',
  optionsParameters,
  routes.detail_build.path,
)
export const detailSliceTool = makeTool(
  'detail_slice',
  'Run the configured real slicer on exactly this candidate and return measured path/filament evidence.',
  candidateParameters,
  routes.detail_slice.path,
)
export const detailVerifyTool = makeTool(
  'detail_verify',
  'Check dimensions, closed geometry, protected-ROI fidelity, and raised extrusion paths for this candidate.',
  candidateParameters,
  routes.detail_verify.path,
)
export const detailSubmitTool = makeTool(
  'detail_submit',
  'Submit only this exact candidate after its server-side geometry, slicer, and detail-path verification all pass.',
  candidateParameters,
  routes.detail_submit.path,
)

export const printDetailTools = Object.freeze(Object.values(routes).map((route, index) => ({
  name: Object.keys(routes)[index], path: route.path, parameters: route.parameters,
})))
