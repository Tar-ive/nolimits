// Devin Desktop (Cascade) support for the gateway.
//
// The IDE's language server sends agent inference as
//   POST server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage
// (Connect streaming protobuf, gzip-framed). We point codeium.apiServerUrl at
// this gateway; GetChatMessage is decoded and redirected to OpenCode, and EVERY
// other server.codeium.com call is transparently proxied through so auth,
// seat-management, analytics, etc. keep working.
import type { Context } from 'hono'
import {
  deframe,
  decodeRequest,
  buildResponseStream,
  type DevinRequest,
  type UpstreamResult,
} from './connect-codec'

const OPENCODE_URL =
  process.env.DEVIN_OPENCODE_URL || 'https://opencode.ai/zen/go/v1/chat/completions'
const OPENCODE_KEY = process.env.OPENCODE_API_KEY || ''
const MODEL = process.env.DEVIN_MODEL || 'glm-5.2'
const MAX_TOKENS = Number(process.env.DEVIN_MAX_TOKENS || '8192')
const CODEIUM_UPSTREAM = process.env.DEVIN_CODEIUM_UPSTREAM || 'https://server.codeium.com'

export const GETCHATMESSAGE_PATH =
  '/exa.api_server_pb.ApiServerService/GetChatMessage'

function safeJson(s: string): unknown {
  try {
    return s ? JSON.parse(s) : { type: 'object' }
  } catch {
    return { type: 'object' }
  }
}

function toOpenAI(req: DevinRequest): any {
  const messages: any[] = [{ role: 'system', content: req.system }]
  for (const m of req.messages) {
    // Fold system/tool turns into user turns (proven to work with OpenCode);
    // keep assistant turns as assistant so alternation reads correctly.
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const content = m.content || (role === 'assistant' ? '(tool call)' : '(no content)')
    if (messages.length && messages[messages.length - 1].role === role) {
      messages[messages.length - 1].content += '\n\n' + content
    } else {
      messages.push({ role, content })
    }
  }
  const tools = req.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: safeJson(t.schema) },
  }))
  const body: any = { model: MODEL, max_tokens: MAX_TOKENS, messages }
  if (tools.length) body.tools = tools
  return body
}

async function callOpenCode(body: any): Promise<UpstreamResult> {
  let resp: any
  try {
    const r = await fetch(OPENCODE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'curl/8.7.1', // OpenCode Cloudflare 403s the default UA
        authorization: `Bearer ${OPENCODE_KEY}`,
      },
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      const detail = await r.text()
      let msg = detail
      try {
        msg = JSON.parse(detail).error?.message ?? detail
      } catch {}
      return { reasoning: '', content: `⚠️ Gateway error ${r.status}: ${msg}`, toolCalls: [], ok: true }
    }
    resp = await r.json()
  } catch (e) {
    return { reasoning: '', content: `⚠️ Gateway error: ${e}`, toolCalls: [], ok: true }
  }
  const msg = resp.choices?.[0]?.message ?? {}
  const toolCalls = (msg.tool_calls ?? []).map((tc: any) => ({
    id: tc.id || 'call_' + Math.random().toString(36).slice(2, 18),
    name: tc.function?.name ?? '',
    args: tc.function?.arguments ?? '{}',
  }))
  return {
    reasoning: msg.reasoning_content ?? '',
    content: msg.content ?? '',
    toolCalls,
    ok: true,
  }
}

export async function handleGetChatMessage(c: Context): Promise<Response> {
  const raw = Buffer.from(await c.req.arrayBuffer())
  let result: UpstreamResult
  try {
    const req = decodeRequest(deframe(raw, true)[0])
    console.log(
      `[devin-ide] GetChatMessage model=${req.model} msgs=${req.messages.length} tools=${req.tools.length} -> ${MODEL}`,
    )
    result = await callOpenCode(toOpenAI(req))
  } catch (e) {
    console.error('[devin-ide] decode/call failed:', e)
    result = { reasoning: '', content: '', toolCalls: [], ok: false }
  }
  const body = buildResponseStream('bot-' + crypto.randomUUID(), Math.floor(Date.now() / 1000), result)
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/connect+proto', 'connect-protocol-version': '1' },
  })
}

// Transparent reverse proxy to the real Codeium backend for every non-inference call.
export async function passthroughCodeium(c: Context): Promise<Response> {
  const inUrl = new URL(c.req.url)
  const target = CODEIUM_UPSTREAM + inUrl.pathname + inUrl.search
  const headers = new Headers()
  c.req.raw.headers.forEach((v, k) => {
    if (!['host', 'content-length', 'connection'].includes(k.toLowerCase())) headers.set(k, v)
  })
  const method = c.req.method
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : Buffer.from(await c.req.arrayBuffer())
  const r = await fetch(target, { method, headers, body })
  const respHeaders = new Headers()
  r.headers.forEach((v, k) => {
    if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k.toLowerCase()))
      respHeaders.set(k, v)
  })
  return new Response(r.body, { status: r.status, headers: respHeaders })
}
