import { writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const AGNES_CHAT_URL = 'https://api.agnes-ai.cn/v1/chat/completions'
const PROBE_ENDPOINTS = new Map([[AGNES_CHAT_URL, 'agnes-chat-completions'], ['https://api.commandcode.ai/provider/v1/responses', 'command-code-responses']])
const TRACE_DIRECTORY = ['data', 'print-validation']

function assertTracePath(projectRoot, tracePath) {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)
      || typeof tracePath !== 'string' || !isAbsolute(tracePath)) {
    throw new TypeError('offline tool trace paths must be absolute project paths')
  }
  const root = resolve(projectRoot)
  const allowed = resolve(root, ...TRACE_DIRECTORY)
  const target = resolve(tracePath)
  const rel = relative(allowed, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError('offline tool trace must be a file below data/print-validation')
  }
  return target
}

async function readRequestBody(input, init) {
  if (typeof init?.body === 'string') return init.body
  if (init?.body instanceof Uint8Array) return Buffer.from(init.body).toString('utf8')
  if (input instanceof Request) return input.clone().text()
  return ''
}

function safeToolNames(body) {
  try {
    const parsed = JSON.parse(body)
    const model = typeof parsed.model === 'string' && /^[A-Za-z0-9._/-]{1,160}$/u.test(parsed.model)
      ? parsed.model
      : 'unknown'
    const names = Array.isArray(parsed.tools) ? parsed.tools.slice(0, 64).map((tool) => tool?.name ?? tool?.function?.name) : []
    const toolNames = names.filter((name) => typeof name === 'string' && /^[A-Za-z0-9_.-]{1,96}$/u.test(name))
    return { model, toolNames }
  } catch {
    return { model: 'unparseable', toolNames: [] }
  }
}

export class OfflineToolProbeBlocked extends Error {
  constructor() {
    super('OFFLINE_TOOL_PROBE_BLOCKED')
    this.name = 'OfflineToolProbeBlocked'
    this.code = 'OFFLINE_TOOL_PROBE_BLOCKED'
  }
}

export function createOfflineFetchGate({ projectRoot, tracePath, originalFetch, now = () => new Date().toISOString() }) {
  if (typeof originalFetch !== 'function') throw new TypeError('originalFetch must be a function')
  const targetPath = assertTracePath(projectRoot, tracePath)
  return async function offlineFetch(input, init) {
    const requested = input instanceof Request ? input.url : String(input)
    const url = new URL(requested)
    if (!PROBE_ENDPOINTS.has(url.href)) throw new OfflineToolProbeBlocked()

    const body = await readRequestBody(input, init)
    const { model, toolNames } = safeToolNames(body)
    const trace = {
      at: now(),
      endpoint: PROBE_ENDPOINTS.get(url.href),
      model,
      toolNames,
      blockedBeforeFetch: true,
    }
    writeFileSync(targetPath, `${JSON.stringify(trace)}\n`, { encoding: 'utf8', flag: 'wx' })
    // Throw only after capture and outside any fetch call: this request never reaches the network.
    throw new OfflineToolProbeBlocked()
  }
}

export function installOfflineFetchGate(env = process.env) {
  if (env.PHOTO_CAD_OFFLINE_TOOL_PROBE !== '1') return false
  const projectRoot = env.PHOTO_CAD_OFFLINE_TOOL_PROBE_ROOT
  const tracePath = env.PHOTO_CAD_OFFLINE_TOOL_PROBE_TRACE
  if (typeof projectRoot !== 'string' || typeof tracePath !== 'string')
    throw new TypeError('offline tool probe requires project-contained trace configuration')
  const originalFetch = globalThis.fetch
  globalThis.fetch = createOfflineFetchGate({ projectRoot, tracePath, originalFetch })
  return true
}

if (process.env.PHOTO_CAD_OFFLINE_TOOL_PROBE === '1') installOfflineFetchGate()

export const offlineProbeInternals = { assertTracePath, safeToolNames }
