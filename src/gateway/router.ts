import { getGatewayConfig, type ProviderConfig } from './config'

export type Effort = 'low' | 'medium' | 'high' | 'max'

export interface Route {
  provider: ProviderConfig
  upstreamModel: string
  isPrimary: boolean
}

// Cursor's "thinking" model entries use aliases like
// claude-sonnet-5-thinking-high, which upstreams 404 on. Strip the suffix and
// surface the level so the caller can map it to an effort parameter. Runs
// before routing for every provider.
export function stripThinkingSuffix(model: string): {
  model: string
  effort?: Effort
} {
  const match = model.match(/^(.*?)-thinking(?:-(low|medium|high|max))?$/)
  if (match) {
    return {
      model: match[1],
      effort: (match[2] as Effort | undefined) ?? undefined,
    }
  }
  return { model }
}

// A provider can serve a model id when either the id already carries no family
// (Cursor serves everything) or the id matches one of the provider's kinds.
// Used to drop cross-family *bare* fallbacks: e.g. `openai` can't serve a
// `claude-*` id, so a bare `openai` fallback for a claude request is dropped.
function providerCanServe(provider: ProviderConfig, model: string): boolean {
  if (provider.kind === 'cursor') return true // Cursor serves both families
  if (provider.kind === 'anthropic-oauth' || provider.kind === 'devin-oauth') return /^claude/.test(model)
  // openai-compatible: assume it can serve any non-claude id (gpt/o*, local models)
  return !/^claude/.test(model)
}

function resolvePrimary(model: string): {
  route: Route
  explicit: boolean
} | null {
  const config = getGatewayConfig()

  // (1) Explicit provider/ prefix pins the request (fast mode). A slash is our
  // own pin convention, and /v1/models only advertises prefixes for registered
  // providers — so an unregistered prefix is a routing error (→ 400), not a
  // fall-through that would misroute a bogus slash-model to the default upstream.
  const slash = model.indexOf('/')
  if (slash > 0) {
    const prefix = model.slice(0, slash)
    const rest = model.slice(slash + 1)
    const provider = config.providers[prefix]
    if (provider) {
      return {
        route: { provider, upstreamModel: rest, isPrimary: true },
        explicit: true,
      }
    }
    return null
  }

  // (2) First matching pattern.
  for (const pattern of config.modelPatterns) {
    if (pattern.match.test(model)) {
      const provider = config.providers[pattern.provider]
      if (provider) {
        return {
          route: { provider, upstreamModel: model, isPrimary: true },
          explicit: false,
        }
      }
      // Pattern points at an unregistered provider (e.g. no OPENAI_API_KEY).
      // Signal "not routable" so the caller returns a helpful 400.
      return null
    }
  }

  // (3) Default provider.
  const provider = config.providers[config.defaultProvider]
  if (!provider) return null
  return {
    route: { provider, upstreamModel: model, isPrimary: true },
    explicit: false,
  }
}

// Expand a fallback entry ("provider/model" or bare "provider") into a Route,
// or null if the target provider is unregistered or can't serve the model.
function expandFallback(entry: string, requestModel: string): Route | null {
  const config = getGatewayConfig()
  const slash = entry.indexOf('/')
  if (slash > 0) {
    const providerName = entry.slice(0, slash)
    const upstreamModel = entry.slice(slash + 1)
    const provider = config.providers[providerName]
    if (!provider) return null
    return { provider, upstreamModel, isPrimary: false }
  }
  // Bare provider: reuse the incoming model id — only valid if that provider
  // can actually serve it (drops e.g. bare `openai` for a claude request).
  const provider = config.providers[entry]
  if (!provider) return null
  if (!providerCanServe(provider, requestModel)) return null
  return { provider, upstreamModel: requestModel, isPrimary: false }
}

// Build the ordered failover chain for a (post-thinking-strip) model id.
// Empty array => the primary provider isn't registered (caller returns 400).
// An explicit provider/ prefix pins to a single route (no fallbacks).
export function resolveChain(model: string): Route[] {
  const primary = resolvePrimary(model)
  if (!primary) return []

  if (primary.explicit) return [primary.route]

  const config = getGatewayConfig()
  const chain: Route[] = [primary.route]
  const fallbackEntries = config.fallbacks[primary.route.provider.name] ?? []
  for (const entry of fallbackEntries) {
    const route = expandFallback(entry, primary.route.upstreamModel)
    if (route && route.provider.name !== primary.route.provider.name) {
      chain.push(route)
    }
  }
  return chain
}
