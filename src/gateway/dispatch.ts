import type { Context } from 'hono'
import type { Route, Effort } from './router'
import { handlerFor } from './handlers'
import {
  isCoolingDown,
  setCooldown,
  isLimitStatus,
  cooldownFromResponse,
} from './limits'
import { noticeText } from './notice'

// Runs an OpenAI-format request through the failover chain: try each route
// (skipping cooled-down providers), advance on any limit status / thrown error,
// and inject a switch notice when a non-primary backend answers.
//
// `fetch` resolves at response headers, so the limit decision is always made
// before any body byte is streamed — safe to abandon a route and try the next
// even for streaming requests.
export async function dispatch(
  c: Context,
  openAIBody: any,
  chain: Route[],
  effort: Effort | undefined,
): Promise<Response> {
  const isStreaming = openAIBody.stream === true
  const requestModel = openAIBody.model
  let lastError: { status: number; provider: string } | null = null

  for (const route of chain) {
    if (await isCoolingDown(route.provider.name)) continue

    // Each handler mutates its body in place (system injection, model rename,
    // format conversion), so every attempt starts from a pristine clone.
    const attemptBody = structuredClone(openAIBody)
    const handler = handlerFor(route.provider.kind)

    let upstream
    try {
      upstream = await handler.fetchUpstream(attemptBody, route, {
        effort,
        isStreaming,
      })
    } catch (error) {
      console.error(`[gateway] ${route.provider.name} fetch threw:`, error)
      await setCooldown(route.provider.name, Date.now() + 60_000, 'network error')
      lastError = { status: 502, provider: route.provider.name }
      continue
    }

    if (isLimitStatus(upstream.status)) {
      const until = Date.now() + cooldownFromResponse(upstream)
      await setCooldown(route.provider.name, until, `HTTP ${upstream.status}`)
      lastError = { status: upstream.status, provider: route.provider.name }
      continue
    }

    const notice = route.isPrimary
      ? null
      : noticeText(requestModel, route, 'primary unavailable')
    if (notice) console.log(`↪️  ${notice}`)

    return handler.render(c, upstream, attemptBody, { notice, isStreaming })
  }

  return c.json(
    {
      error: {
        message: lastError
          ? `All providers exhausted (last: ${lastError.provider} HTTP ${lastError.status}). Every backend in the chain is rate-limited or cooling down.`
          : 'All providers are cooling down; no route available.',
        type: 'all_providers_exhausted',
      },
    },
    503,
  )
}
