import type { Model, Provider as PiProvider } from '@earendil-works/pi-ai'

export const COMMAND_CODE_BASE_URL = 'https://api.commandcode.ai/provider/v1'
export const COMMAND_CODE_MODEL_ID = 'deepseek/deepseek-v4.1-flash'

/**
 * Command Code's live catalogue identifies this model and its OpenAI Responses support. The
 * runtime record remains static and reviewed; host configuration only accepts the model when the
 * authenticated /models response contains this exact id. Command Code does not publish cost in
 * that catalogue, so zero is an accounting placeholder, not a price claim.
 */
const COMMAND_CODE_MODELS: Model<'openai-responses'>[] = [
  {
    id: COMMAND_CODE_MODEL_ID,
    name: 'DeepSeek V4.1 Flash (Command Code)',
    provider: 'command-code',
    api: 'openai-responses',
    baseUrl: COMMAND_CODE_BASE_URL,
    input: ['text'],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
]

/** This registry adapter consumes only the provider identity and fixed model catalogue. */
export function commandCodeProvider(): PiProvider {
  return {
    id: 'command-code',
    name: 'Command Code',
    baseUrl: COMMAND_CODE_BASE_URL,
    getModels: () => COMMAND_CODE_MODELS,
  } as unknown as PiProvider
}
