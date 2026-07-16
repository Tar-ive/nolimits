import { AnthropicRequestBody } from '../types'

// OpenAI request params that Anthropic's /v1/messages rejects as extra inputs.
// temperature/top_p are also dropped: Claude Sonnet 5+ rejects non-default
// sampling params, and OpenAI clients may send values > 1.
const UNSUPPORTED_PARAMS = [
  'stream_options',
  'frequency_penalty',
  'presence_penalty',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'n',
  'seed',
  'user',
  'parallel_tool_calls',
  'response_format',
  'store',
  'modalities',
  'prediction',
  'reasoning_effort',
  'verbosity',
  'service_tier',
  'prompt_cache_key',
  'safety_identifier',
  'temperature',
  'top_p',
  'max_completion_tokens',
  'stop',
  'functions',
  'function_call',
]

// Flatten OpenAI message content (string or content-part array) to plain text
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text)
      .join('\n')
  }
  return ''
}

function convertContentPart(part: any): any | null {
  if (!part || typeof part !== 'object') return null
  if (part.type === 'text') {
    return { type: 'text', text: part.text ?? '' }
  }
  if (part.type === 'image_url' && part.image_url?.url) {
    const url: string = part.image_url.url
    const dataUrlMatch = url.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/i)
    if (dataUrlMatch) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: dataUrlMatch[1],
          data: dataUrlMatch[2],
        },
      }
    }
    return { type: 'image', source: { type: 'url', url } }
  }
  // Already-Anthropic blocks (tool_use, tool_result, image, ...) pass through
  if (part.type) return part
  return null
}

function convertMessage(msg: any): any | null {
  if (!msg || typeof msg !== 'object') return null

  // OpenAI tool result -> Anthropic tool_result block in a user message.
  // Anthropic combines consecutive same-role messages, so one message per
  // result is fine.
  if (msg.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: contentToText(msg.content),
        },
      ],
    }
  }

  // OpenAI assistant tool calls -> Anthropic tool_use blocks
  if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    const blocks: any[] = []
    const text = contentToText(msg.content)
    if (text) blocks.push({ type: 'text', text })
    for (const call of msg.tool_calls) {
      let input: unknown = {}
      try {
        input = JSON.parse(call.function?.arguments || '{}')
      } catch {
        input = {}
      }
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.function?.name,
        input,
      })
    }
    return { role: 'assistant', content: blocks }
  }

  const content = Array.isArray(msg.content)
    ? msg.content.map(convertContentPart).filter(Boolean)
    : msg.content ?? ''

  // Anthropic rejects empty message content
  if (
    (typeof content === 'string' && content.trim() === '') ||
    (Array.isArray(content) && content.length === 0)
  ) {
    return null
  }

  // Strip OpenAI-only per-message fields (name, refusal, audio, ...)
  return { role: msg.role, content }
}

const EPHEMERAL = { type: 'ephemeral' }

function markLastBlock(msg: any): boolean {
  if (!msg) return false
  if (typeof msg.content === 'string') {
    msg.content = [
      { type: 'text', text: msg.content, cache_control: EPHEMERAL },
    ]
    return true
  }
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    msg.content[msg.content.length - 1].cache_control = EPHEMERAL
    return true
  }
  return false
}

// OpenAI-protocol clients (Cursor) never send cache_control, so without this
// every agent round reprocesses the full conversation uncached. Mirror Claude
// Code's strategy: one breakpoint after tools+system, one at the end of the
// conversation, one a turn earlier as a stable read point (also guards the
// ~20-block cache lookback limit in tool-heavy turns). Max 4 allowed; we use 3.
function applyCacheControl(body: AnthropicRequestBody): void {
  // Cache the tool block too (large for agent clients like Devin: ~24 schemas).
  // A breakpoint on the last tool caches all tools + the system that follows.
  const anyBody = body as any
  if (Array.isArray(anyBody.tools) && anyBody.tools.length > 0) {
    ;(anyBody.tools[anyBody.tools.length - 1] as any).cache_control = EPHEMERAL
  }

  if (Array.isArray(body.system) && body.system.length > 0) {
    ;(body.system[body.system.length - 1] as any).cache_control = EPHEMERAL
  }

  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) return

  markLastBlock(messages[messages.length - 1])

  for (let i = messages.length - 2; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      markLastBlock(messages[i])
      break
    }
  }
}

// Anthropic enforces two cache_control rules that client hints (Cursor's
// survive conversion untouched) can violate once ours are added on top:
//   1. cache_control is illegal inside tool_result.content — strip it there.
//   2. At most 4 legally-placed blocks (tools, system, top-level message
//      content) may carry it — keep the last 4 in document order, since a
//      breakpoint caches everything before it.
// Deliberately not a blind deep walk: a cache_control key inside e.g.
// tool_use.input is tool-argument data and must not be touched.
export function enforceCacheControlLimit(body: AnthropicRequestBody): void {
  const anyBody = body as any
  const marked: any[] = []
  const collect = (block: any) => {
    if (block && typeof block === 'object' && block.cache_control) {
      marked.push(block)
    }
  }
  for (const tool of Array.isArray(anyBody.tools) ? anyBody.tools : []) {
    collect(tool)
  }
  for (const block of Array.isArray(body.system) ? body.system : []) {
    collect(block)
  }
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!Array.isArray(msg?.content)) continue
    for (const block of msg.content) {
      collect(block)
      if (block?.type === 'tool_result' && Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner && typeof inner === 'object') delete inner.cache_control
        }
      }
    }
  }
  for (const block of marked.slice(0, -4)) {
    delete block.cache_control
  }
}

// Rewrite an OpenAI chat-completions request body in place so it is a valid
// Anthropic /v1/messages request. System-message extraction is handled by the
// caller before this runs.
export function convertOpenAIRequest(body: AnthropicRequestBody): void {
  const anyBody = body as any

  if (!anyBody.max_tokens && typeof anyBody.max_completion_tokens === 'number') {
    anyBody.max_tokens = anyBody.max_completion_tokens
  }

  if (anyBody.stop) {
    anyBody.stop_sequences = Array.isArray(anyBody.stop) ? anyBody.stop : [anyBody.stop]
  }

  if (Array.isArray(anyBody.tools)) {
    anyBody.tools = anyBody.tools
      .map((tool: any) => {
        if (tool?.type === 'function' && tool.function?.name) {
          return {
            name: tool.function.name,
            description: tool.function.description || '',
            input_schema: tool.function.parameters || {
              type: 'object',
              properties: {},
            },
          }
        }
        // OpenAI freeform "custom" tools have no JSON schema — wrap the raw
        // string input in a single-property schema Anthropic accepts
        if (tool?.type === 'custom' && tool.custom?.name) {
          return {
            name: tool.custom.name,
            description: tool.custom.description || '',
            input_schema: {
              type: 'object',
              properties: {
                input: {
                  type: 'string',
                  description: 'The tool input as free-form text',
                },
              },
              required: ['input'],
            },
          }
        }
        // Already Anthropic-shaped tools pass through
        if (tool?.name && tool?.input_schema) return tool
        console.log(`dropping unsupported tool type: ${tool?.type || 'unknown'}`)
        return null
      })
      .filter(Boolean)
    if (anyBody.tools.length === 0) delete anyBody.tools
  }

  const toolChoice = anyBody.tool_choice
  if (typeof toolChoice === 'string') {
    anyBody.tool_choice =
      toolChoice === 'required'
        ? { type: 'any' }
        : toolChoice === 'none'
        ? { type: 'none' }
        : { type: 'auto' }
  } else if (toolChoice?.type === 'function' && toolChoice.function?.name) {
    anyBody.tool_choice = { type: 'tool', name: toolChoice.function.name }
  }
  if (anyBody.tool_choice && !anyBody.tools) delete anyBody.tool_choice

  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map(convertMessage).filter(Boolean)
  }

  for (const key of UNSUPPORTED_PARAMS) {
    delete anyBody[key]
  }

  applyCacheControl(body)
  enforceCacheControlLimit(body)
}
