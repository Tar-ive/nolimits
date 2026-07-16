import { randomUUID, createHash } from 'node:crypto'
import { stream } from 'hono/streaming'
import { contentToText } from '../../utils/openai-to-anthropic-request'
import { getCursorToken } from '../cursor-auth'
import {
  encodeChatRequest,
  CursorFrameDecoder,
  type CursorChatMessage,
} from '../cursor-proto'
import { noticeSSELine, prependNoticeJson } from '../notice'
import type {
  ProviderHandler,
  UpstreamResponse,
  FetchContext,
  RenderOptions,
} from './types'
import { jsonResponse } from './types'

// ─── Version-sensitive wire constants (VALIDATE against a live token) ────────
// The Connect-RPC path and checksum drift between Cursor releases.
const RPC_PATH = '/aiserver.v1.ChatService/StreamUnifiedChatWithTools'
const CLIENT_VERSION = '0.42.0'
// ─────────────────────────────────────────────────────────────────────────────

// x-cursor-checksum: obfuscated timestamp + hashed machine ids. This is the
// most fragile piece and MUST be confirmed empirically; centralized here so a
// corrected algorithm is a one-function change.
function generateChecksum(token: string): string {
  const now = Math.floor(Date.now() / 1_000_000)
  const bytes = [
    (now >> 40) & 0xff,
    (now >> 32) & 0xff,
    (now >> 24) & 0xff,
    (now >> 16) & 0xff,
    (now >> 8) & 0xff,
    now & 0xff,
  ]
  let prev = 165
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = ((bytes[i] ^ prev) + (i % 256)) & 0xff
    prev = bytes[i]
  }
  const timeHeader = Buffer.from(bytes).toString('base64')
  const machineId = createHash('sha256').update(token).digest('hex')
  const macId = createHash('sha256').update(token + '::mac').digest('hex')
  return `${timeHeader}${machineId}/${macId}`
}

function toCursorMessages(openAIMessages: any[]): CursorChatMessage[] {
  return (openAIMessages ?? [])
    .map((m): CursorChatMessage | null => {
      const text = contentToText(m.content)
      if (!text) return null
      const role: 1 | 2 = m.role === 'assistant' ? 2 : 1
      return { text, role }
    })
    .filter((m): m is CursorChatMessage => m !== null)
}

async function fetchUpstream(
  body: any,
  route: { provider: { baseUrl: string }; upstreamModel: string },
  _ctx: FetchContext,
): Promise<UpstreamResponse> {
  const token = await getCursorToken()
  if (!token) {
    return jsonResponse(
      {
        error: {
          message:
            'Cursor session token missing. Set CURSOR_SESSION_TOKEN or POST /auth/cursor/token.',
          type: 'authentication_error',
        },
      },
      401,
    )
  }

  const frame = encodeChatRequest(
    route.upstreamModel,
    toCursorMessages(body.messages),
  )

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/connect+proto',
    'connect-protocol-version': '1',
    'x-cursor-checksum': generateChecksum(token),
    'x-request-id': randomUUID(),
    'x-cursor-client-version': CLIENT_VERSION,
    'x-ghost-mode': 'true',
    'user-agent': 'connect-es/1.6.1',
  }

  return fetch(`${route.provider.baseUrl}${RPC_PATH}`, {
    method: 'POST',
    headers,
    body: frame,
  })
}

function openAIChunk(model: string, delta: object, finish: string | null) {
  return {
    id: 'chatcmpl-cursor',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

async function render(
  c: any,
  upstream: UpstreamResponse,
  body: any,
  opts: RenderOptions,
): Promise<Response> {
  const model = body?.model ?? 'cursor'

  if (upstream.status < 200 || upstream.status >= 300) {
    const errText = await upstream.text().catch(() => '')
    return jsonResponse(
      {
        error: {
          message: `Cursor upstream error (HTTP ${upstream.status}): ${errText.slice(0, 500)}`,
          type: 'upstream_error',
        },
      },
      upstream.status === 401 || upstream.status === 403 ? 401 : 502,
    )
  }

  if (opts.isStreaming) {
    const reader = upstream.body!.getReader()
    const decoder = new CursorFrameDecoder()
    return stream(c, async (s) => {
      if (opts.notice) await s.write(noticeSSELine(opts.notice, model))
      try {
        // Prime the assistant role.
        await s.write(
          `data: ${JSON.stringify(openAIChunk(model, { role: 'assistant' }, null))}\n\n`,
        )
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          for (const text of decoder.push(value)) {
            await s.write(
              `data: ${JSON.stringify(openAIChunk(model, { content: text }, null))}\n\n`,
            )
          }
        }
        await s.write(
          `data: ${JSON.stringify(openAIChunk(model, {}, 'stop'))}\n\n`,
        )
        await s.write('data: [DONE]\n\n')
      } catch (error) {
        console.error('Cursor stream error:', error)
      } finally {
        reader.releaseLock()
      }
    })
  }

  // Non-streaming: collect all deltas into one chat.completion.
  const reader = upstream.body!.getReader()
  const decoder = new CursorFrameDecoder()
  let full = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    for (const text of decoder.push(value)) full += text
  }
  const result = {
    id: 'chatcmpl-cursor',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: full },
        finish_reason: 'stop',
      },
    ],
  }
  if (opts.notice) prependNoticeJson(result, opts.notice)
  return c.json(result)
}

export const cursorHandler: ProviderHandler = { fetchUpstream, render }
