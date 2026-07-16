import { stream } from 'hono/streaming'
import { getAccessToken } from '../../auth/oauth-manager'
import {
  createConverterState,
  processChunk,
  convertNonStreamingResponse,
} from '../../utils/anthropic-to-openai-converter'
import {
  convertOpenAIRequest,
  contentToText,
} from '../../utils/openai-to-anthropic-request'
import { noticeSSELine, prependNoticeJson } from '../notice'
import type {
  ProviderHandler,
  UpstreamResponse,
  FetchContext,
  RenderOptions,
} from './types'
import { jsonResponse } from './types'

const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."

// The dispatch path only reaches this handler with OpenAI-format bodies (the
// Cursor case), so conversion to/from Anthropic format is always applied. The
// raw Claude Code passthrough lives in server.ts and never comes through here.
async function fetchUpstream(
  body: any,
  route: { provider: { baseUrl: string }; upstreamModel: string },
  ctx: FetchContext,
): Promise<UpstreamResponse> {
  body.model = route.upstreamModel

  // Move any OpenAI system messages into Anthropic `system`, led by the Claude
  // Code marker (mirrors the original messagesFn behavior).
  const systemMessages = (body.messages ?? []).filter(
    (m: any) => m.role === 'system',
  )
  body.messages = (body.messages ?? []).filter((m: any) => m.role !== 'system')
  if (!body.system) body.system = []
  body.system.unshift({ type: 'text', text: CLAUDE_CODE_SYSTEM })
  for (const sysMsg of systemMessages) {
    body.system.push({ type: 'text', text: contentToText(sysMsg.content) })
  }

  if (body.model.includes('opus')) body.max_tokens = 32_000
  if (body.model.includes('sonnet')) body.max_tokens = 64_000

  if (ctx.effort && !body.output_config) {
    body.output_config = { effort: ctx.effort }
  }

  if (!body.metadata) body.metadata = {}
  convertOpenAIRequest(body)
  if (!body.max_tokens) body.max_tokens = 32_000

  const oauthToken = await getAccessToken()
  if (!oauthToken) {
    return jsonResponse(
      {
        error: 'Authentication required',
        message:
          'Please authenticate using OAuth first. Visit /auth/login for instructions.',
      },
      401,
    )
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${oauthToken}`,
    'anthropic-beta':
      'oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
    'anthropic-version': '2023-06-01',
    'user-agent': '@anthropic-ai/sdk 1.2.12 node/22.13.1',
    accept: ctx.isStreaming ? 'text/event-stream' : 'application/json',
    'accept-encoding': 'gzip, deflate',
  }

  return fetch(`${route.provider.baseUrl}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

async function render(
  c: any,
  upstream: UpstreamResponse,
  _body: any,
  opts: RenderOptions,
): Promise<Response> {
  const model = _body?.model ?? 'claude'

  if (upstream.status < 200 || upstream.status >= 300) {
    const errText = await upstream.text()
    console.error('API Error:', errText)
    if (upstream.status === 401) {
      return jsonResponse(
        {
          error: 'Authentication failed',
          message:
            'OAuth token may be expired. Please re-authenticate using /auth/login/start',
          details: errText,
        },
        401,
      )
    }
    return new Response(errText, {
      status: upstream.status,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  if (opts.isStreaming) {
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase()
      if (
        k !== 'content-encoding' &&
        k !== 'content-length' &&
        k !== 'transfer-encoding'
      ) {
        c.header(key, value)
      }
    })

    const reader = upstream.body!.getReader()
    const decoder = new TextDecoder()

    return stream(c, async (s) => {
      if (opts.notice) {
        await s.write(noticeSSELine(opts.notice, model))
      }
      const converterState = createConverterState()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          const results = processChunk(converterState, chunk, false)
          for (const result of results) {
            if (result.type === 'chunk') {
              await s.write(`data: ${JSON.stringify(result.data)}\n\n`)
            } else if (result.type === 'done') {
              await s.write('data: [DONE]\n\n')
            }
          }
        }
      } catch (error) {
        console.error('Stream error:', error)
      } finally {
        reader.releaseLock()
      }
    })
  }

  const responseData = (await upstream.json()) as any
  const openAIResponse = convertNonStreamingResponse(responseData)
  if (opts.notice) prependNoticeJson(openAIResponse, opts.notice)

  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'content-encoding') c.header(key, value)
  })
  return c.json(openAIResponse)
}

export const anthropicHandler: ProviderHandler = { fetchUpstream, render }
