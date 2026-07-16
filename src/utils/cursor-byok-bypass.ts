import { AnthropicRequestBody } from "../types";

// Bypass cursor enable openai key check
export function createCursorBypassResponse() {
  return {
    choices: [
      {
        finish_reason: 'length',
        index: 0,
        logprobs: null,
        message: {
          annotations: [],
          content: 'Of course! Please provide me with the text or',
          refusal: null,
          role: 'assistant',
        },
      },
    ],
    created: 1751755415,
    id: 'chatcmpl-Bq5tXYkUOGxyRInJljhsBrlLP1066',
    model: 'gpt-4o-2024-08-06',
    object: 'chat.completion',
    service_tier: 'default',
    system_fingerprint: 'fp_a288987b44',
    usage: {
      completion_tokens: 10,
      completion_tokens_details: {
        accepted_prediction_tokens: 0,
        audio_tokens: 0,
        reasoning_tokens: 0,
        rejected_prediction_tokens: 0,
      },
      prompt_tokens: 28,
      prompt_tokens_details: {
        audio_tokens: 0,
        cached_tokens: 0,
      },
      total_tokens: 38,
    },
  }
}

// Check if the request is from Cursor trying to validate its OpenAI key.
//
// The test-prompt content check is unconditional. The gpt-4o *model* check is
// only a valid key-probe signal when no OpenAI-serving provider is configured —
// otherwise it would hijack every real gpt-4o request once OpenAI/Cursor
// routing exists. `hasOpenAIProvider` preserves today's Vercel behavior.
export function isCursorKeyCheck(
  body: AnthropicRequestBody,
  hasOpenAIProvider: boolean,
): boolean {
  const isTestPrompt =
    !!body.messages &&
    body.messages.some(
      (m: any) => m.content === 'Test prompt using gpt-3.5-turbo',
    )
  if (isTestPrompt) return true
  if (!hasOpenAIProvider && !!body.model?.includes('gpt-4o')) return true
  return false
}
