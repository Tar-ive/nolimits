import type { Context } from 'hono'
import type { Route, Effort } from '../router'

// Minimal shape the dispatcher needs from an upstream call. The native `fetch`
// Response satisfies this structurally; the cursor handler returns a wrapper
// that also implements it.
export interface UpstreamResponse {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
  text(): Promise<string>
  json(): Promise<any>
}

export interface FetchContext {
  effort?: Effort
  isStreaming: boolean
}

export interface RenderOptions {
  // Non-null when a non-primary backend served the request — rendered as a
  // short leading line so the user sees which provider answered.
  notice: string | null
  isStreaming: boolean
}

export interface ProviderHandler {
  // Performs the upstream request and resolves at response headers (pre-body),
  // so the dispatcher can inspect .status and fail over before any bytes stream.
  fetchUpstream(
    body: any,
    route: Route,
    ctx: FetchContext,
  ): Promise<UpstreamResponse>
  // Renders the client-facing (always OpenAI-format) response, injecting the
  // switch notice when present.
  render(
    c: Context,
    upstream: UpstreamResponse,
    body: any,
    opts: RenderOptions,
  ): Response | Promise<Response>
}

export function jsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
