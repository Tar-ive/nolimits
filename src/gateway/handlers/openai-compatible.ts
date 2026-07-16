import { prependToStream, noticeSSELine, prependNoticeJson } from '../notice'
import type {
  ProviderHandler,
  UpstreamResponse,
  FetchContext,
  RenderOptions,
} from './types'

// Pure reverse proxy for any OpenAI-compatible upstream (OpenAI, Ollama,
// LM Studio). No SSE parsing — request and response are piped verbatim.
async function fetchUpstream(
  body: any,
  route: { provider: { baseUrl: string; apiKey?: string }; upstreamModel: string },
  ctx: FetchContext,
): Promise<UpstreamResponse> {
  body.model = route.upstreamModel

  if (ctx.effort && body.reasoning_effort == null) {
    body.reasoning_effort = ctx.effort === 'max' ? 'high' : ctx.effort
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // A browser-like UA is required for some Cloudflare-fronted upstreams
    // (e.g. OpenCode Go returns 403 "error code: 1010" to the default fetch UA).
    'user-agent': 'curl/8.7.1',
  }
  // Only send the provider's own key. Never forward the client's inbound
  // Authorization (that is the proxy's own API_KEY, meaningless upstream).
  if (route.provider.apiKey) {
    headers.authorization = `Bearer ${route.provider.apiKey}`
  }

  return fetch(`${route.provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

async function render(
  c: any,
  upstream: UpstreamResponse,
  body: any,
  opts: RenderOptions,
): Promise<Response> {
  const headers = new Headers()
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (
      k !== 'content-encoding' &&
      k !== 'content-length' &&
      k !== 'transfer-encoding'
    ) {
      headers.set(key, value)
    }
  })

  // Notice only rides along on a successful (2xx) response; error bodies pipe
  // through untouched so OpenAI-shaped errors reach Cursor intact.
  const success = upstream.status >= 200 && upstream.status < 300
  const model = body?.model ?? 'gpt'

  if (success && opts.notice) {
    if (opts.isStreaming && upstream.body) {
      // SSE stream: emit the notice as a leading chat.completion.chunk.
      const outBody = prependToStream(
        upstream.body,
        noticeSSELine(opts.notice, model),
      )
      return new Response(outBody, { status: upstream.status, headers })
    }
    // Non-streaming: buffer the single JSON object and prefix the message.
    const json = await upstream.json()
    prependNoticeJson(json, opts.notice)
    headers.delete('content-length')
    headers.set('content-type', 'application/json')
    return new Response(JSON.stringify(json), { status: upstream.status, headers })
  }

  return new Response(upstream.body, { status: upstream.status, headers })
}

export const openaiCompatibleHandler: ProviderHandler = { fetchUpstream, render }
