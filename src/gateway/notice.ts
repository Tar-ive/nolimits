import type { Route } from './router'

// One short line prepended to a reply when a non-primary backend served it, so
// the switch is visible right inside Cursor's chat (also logged in dispatch).
export function noticeText(
  requestModel: string,
  route: Route,
  reason: string,
): string {
  return `[gateway: ${requestModel} ${reason} — served by ${route.provider.name}/${route.upstreamModel}]`
}

// An OpenAI streaming chunk (chat.completion.chunk) carrying the notice text as
// the first delta, serialized as an SSE `data:` line.
export function noticeSSELine(notice: string, model: string): string {
  const chunk = {
    id: 'chatcmpl-gateway-notice',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: `${notice}\n\n` },
        finish_reason: null,
      },
    ],
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}

// Prepend a raw prefix (an SSE line) to a byte stream without buffering the
// rest — used for the openai-compatible and cursor raw pipes.
export function prependToStream(
  source: ReadableStream<Uint8Array>,
  prefix: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const reader = source.getReader()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(prefix))
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

// Prefix the first choice's message content of a non-streaming OpenAI response
// with the notice (mutates in place).
export function prependNoticeJson(obj: any, notice: string): void {
  const message = obj?.choices?.[0]?.message
  if (!message) return
  if (typeof message.content === 'string') {
    message.content = `${notice}\n\n${message.content}`
  } else if (message.content == null) {
    message.content = `${notice}\n\n`
  }
}
