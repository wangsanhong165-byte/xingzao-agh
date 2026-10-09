import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { analyzePhotos, getAghStatus, validateAnalyzePayload } from './agh-runner.mjs'

const temporaryDirs = new Set()
const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

async function fixture({ provider = 'agnes-ai', model = 'agnes-3.0-flash', route = 'personal-route', baseUrl = 'https://api.agnes-ai.cn/v1', doctor } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-cad-agh-test-'))
  temporaryDirs.add(root)
  const profileDir = path.join(root, 'agh-home', 'profiles', 'local-dev')
  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(profileDir, 'configuration.json'), JSON.stringify({
    version: 2,
    profile: 'local-dev',
    revision: 1,
    defaultAccountId: 'primary-account',
    accounts: [{
      accountId: 'primary-account',
      id: provider,
      model,
      route,
      enabled: true,
      credentialRef: 'secret://never-print-this-reference',
      baseUrl,
      label: 'test',
      models: [],
      authType: 'api-key',
    }],
  }))
  const sections = doctor || [{ name: 'provider', status: 'warn', detail: [`configured routes (1): ${route}`, 'credentials and selected-model inference not checked'] }]
  const cli = path.join(root, 'fake-agnes.mjs')
  const serializedSections = JSON.stringify(sections)
  const expectedHome = path.join(root, 'agh-home')
  await writeFile(cli, `if (process.env.AGH_HOME !== ${JSON.stringify(expectedHome)} || process.env.AGNES_HOME || !process.argv.includes('local-dev') || process.env.COMMAND_CODE_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.AGNES_API_KEY) process.stdout.write('[]'); else process.stdout.write(${JSON.stringify(serializedSections)})`)
  return {
    root,
    cli,
    env: {
      ...process.env,
      AGH_HOME: path.join(root, 'existing-default-home'),
      PHOTO_CAD_AGH_HOME: expectedHome,
    },
  }
}

afterEach(async () => {
  await Promise.all([...temporaryDirs].map((dir) => rm(dir, { recursive: true, force: true })))
  temporaryDirs.clear()
})

function validPayload(overrides = {}) {
  return {
    photos: [{ name: 'front.png', mime: 'image/png', dataBase64: imageBytes.toString('base64') }],
    reference: { valueMm: 20, description: 'front side length' },
    description: 'A small mounting part',
    ...overrides,
  }
}

test('status recognizes only a credential-ready configured Agnes model and never returns config secrets', async () => {
  const config = await fixture()
  const status = await getAghStatus({ env: { ...config.env, COMMAND_CODE_API_KEY: 'command-key-canary', DEEPSEEK_API_KEY: 'deepseek-key-canary', AGNES_API_KEY: 'agnes-key-canary' }, cliPath: config.cli })
  assert.equal(status.aghAvailable, true)
  assert.equal(status.modelConfigured, true)
  assert.equal(status.model, 'agnes-3.0-flash')
  assert.deepEqual(Object.keys(status).sort(), ['aghAvailable', 'limits', 'model', 'modelConfigured'])
  assert.equal(JSON.stringify(status).includes('never-print'), false)
})

test('status refuses third-party model routes even if AGH reports a route configured', async () => {
  const config = await fixture({ provider: 'openai', model: 'gpt-test' })
  const status = await getAghStatus({ env: config.env, cliPath: config.cli })
  assert.equal(status.aghAvailable, true)
  assert.equal(status.modelConfigured, false)
  assert.equal(status.model, null)
})

test('status accepts the verified official Agnes international endpoint but rejects arbitrary overrides', async () => {
  const international = await fixture({ baseUrl: 'https://apihub.agnes-ai.com/v1' })
  assert.equal((await getAghStatus({ env: international.env, cliPath: international.cli })).modelConfigured, true)
  const arbitrary = await fixture({ baseUrl: 'https://api.example.invalid/v1' })
  assert.equal((await getAghStatus({ env: arbitrary.env, cliPath: arbitrary.cli })).modelConfigured, false)
})

test('status refuses an Agnes account when AGH reports missing credentials', async () => {
  const config = await fixture({ doctor: [{ name: 'provider', status: 'fail', detail: ['enabled accounts missing usable credentials (1): primary-account'] }] })
  const status = await getAghStatus({ env: config.env, cliPath: config.cli })
  assert.equal(status.modelConfigured, false)
})

test('payload validation accepts up to twelve photos and enforces reference bounds', () => {
  const photos = Array.from({ length: 12 }, (_, index) => ({ name: `view-${index}.png`, mime: 'image/png', dataBase64: imageBytes.toString('base64') }))
  const validated = validateAnalyzePayload(validPayload({ photos }))
  assert.equal(validated.photos.length, 12)
  assert.equal(validated.photos[0].name, 'photo-1.png')
  assert.throws(() => validateAnalyzePayload(validPayload({ reference: { valueMm: 0, description: 'edge' } })), { code: 'INVALID_REFERENCE' })
  assert.throws(() => validateAnalyzePayload(validPayload({ reference: { valueMm: 501, description: 'edge' } })), { code: 'INVALID_REFERENCE' })
  assert.throws(() => validateAnalyzePayload(validPayload({ reference: { valueMm: 20, description: '  ' } })), { code: 'INVALID_REFERENCE' })
})

test('payload validation rejects unsupported and oversized photos before AGH starts', () => {
  assert.throws(() => validateAnalyzePayload(validPayload({ photos: Array.from({ length: 13 }, () => ({ mime: 'image/png', dataBase64: imageBytes.toString('base64') })) })), { code: 'INVALID_PHOTOS' })
  const tooLarge = Buffer.alloc(5 * 1024 * 1024 + 1)
  tooLarge.set(imageBytes)
  assert.throws(() => validateAnalyzePayload(validPayload({ photos: [{ mime: 'image/png', dataBase64: tooLarge.toString('base64') }] })), { code: 'INVALID_PHOTO' })
  assert.throws(() => validateAnalyzePayload(validPayload({ photos: [{ mime: 'image/webp', dataBase64: 'AA==' }] })), { code: 'INVALID_PHOTO' })
})

test('analyze returns MODEL_NOT_CONFIGURED instead of fabricating image analysis', async () => {
  const config = await fixture({ provider: 'openai', model: 'gpt-test' })
  await assert.rejects(analyzePhotos(validPayload(), { env: config.env, cliPath: config.cli }), { code: 'MODEL_NOT_CONFIGURED', status: 503 })
})
