import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type ProviderKind = 'anthropic-oauth' | 'openai-compatible' | 'cursor' | 'devin-oauth'

export interface ProviderConfig {
  name: string
  kind: ProviderKind
  baseUrl: string
  // Credential. For openai-compatible this is the Bearer key; for cursor the
  // WorkosCursorSessionToken. Absent means "keyless" (e.g. Ollama) — such a
  // provider is kept even with no key. anthropic-oauth ignores this (it uses
  // the stored OAuth token).
  apiKey?: string
  // Static model ids surfaced in /v1/models and usable as fallback targets.
  models?: string[]
}

export interface ModelPattern {
  match: RegExp
  provider: string
}

export interface GatewayConfig {
  defaultProvider: string
  providers: Record<string, ProviderConfig>
  modelPatterns: ModelPattern[]
  // providerName -> ordered list of "provider/model" or bare "provider" targets
  fallbacks: Record<string, string[]>
}

// Shape of gateway.config.json on disk (modelPatterns.match is a string there).
interface RawProviderConfig {
  name?: string
  kind: ProviderKind
  baseUrl: string
  apiKey?: string
  models?: string[]
}
interface RawGatewayConfig {
  defaultProvider?: string
  providers?: Record<string, RawProviderConfig>
  modelPatterns?: Array<{ match: string; provider: string }>
  fallbacks?: Record<string, string[]>
}

// Expand ${ENV_VAR} references inside a string. An unset var expands to ''.
function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => process.env[name] ?? '')
}

function expandProvider(name: string, raw: RawProviderConfig): ProviderConfig {
  return {
    name: raw.name ?? name,
    kind: raw.kind,
    baseUrl: expandEnv(raw.baseUrl),
    apiKey: raw.apiKey !== undefined ? expandEnv(raw.apiKey) : undefined,
    models: raw.models,
  }
}

function loadRawConfig(): RawGatewayConfig | null {
  try {
    const path = join(process.cwd(), 'gateway.config.json')
    const text = readFileSync(path, 'utf-8')
    return JSON.parse(text) as RawGatewayConfig
  } catch {
    // Missing/unreadable file is fine — built-in defaults apply (Vercel stays
    // zero-config). A malformed file also falls back to defaults.
    return null
  }
}

function buildDefaults(): {
  providers: Record<string, ProviderConfig>
  modelPatterns: ModelPattern[]
  fallbacks: Record<string, string[]>
} {
  const providers: Record<string, ProviderConfig> = {}

  // Anthropic provider - always available for OAuth
  // This allows normal Claude Code to work without going through proxy
  providers.anthropic = {
    name: 'anthropic',
    kind: 'anthropic-oauth',
    baseUrl: 'https://api.anthropic.com',
  }

  if (process.env.OPENAI_API_KEY) {
    providers.openai = {
      name: 'openai',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
      models: ['gpt-5.1', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
    }
  }

  if (process.env.CURSOR_SESSION_TOKEN) {
    providers.cursor = {
      name: 'cursor',
      kind: 'cursor',
      baseUrl: 'https://api2.cursor.sh',
      apiKey: process.env.CURSOR_SESSION_TOKEN,
      models: ['claude-sonnet-5', 'claude-opus-4.8', 'gpt-5.1', 'gpt-4o'],
    }
  }

  // OpenCode Go (opencode.ai/go) — flat-rate subscription serving open agentic
  // models (GLM, Kimi, DeepSeek, MiniMax) via an OpenAI-compatible surface.
  // Serves full tool payloads with no per-request metering. Used by the Devin
  // CLI redirect and any glm-/kimi-/deepseek-/mimo- routed request.
  if (process.env.OPENCODE_API_KEY) {
    providers.opencode = {
      name: 'opencode',
      kind: 'openai-compatible',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: process.env.OPENCODE_API_KEY,
      models: [
        'glm-5.2',
        'glm-5.1',
        'kimi-k2.7-code',
        'kimi-k2.6',
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'mimo-v2.5-pro',
      ],
    }
  }

  // Devin provider - only used for devin-* prefixed models
  providers.devin = {
    name: 'devin',
    kind: 'devin-oauth',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-5', 'claude-opus-4.8', 'claude-haiku-4'],
  }

  const modelPatterns: ModelPattern[] = [
    { match: /^devin-/, provider: 'devin' }, // Only route devin-* models to Devin provider
    { match: /^claude/, provider: 'anthropic' }, // Normal Claude models go to Anthropic
    { match: /^(gpt-|chatgpt-|o\d)/, provider: 'openai' },
  ]

  // Route open-model families to OpenCode Go when its key is set.
  if (process.env.OPENCODE_API_KEY) {
    modelPatterns.push({ match: /^(glm|kimi|deepseek|mimo|minimax|qwen)/, provider: 'opencode' })
  }

  const fallbacks: Record<string, string[]> = {
    anthropic: ['openai/gpt-5.1', 'cursor'], // No Devin fallback for normal Claude
    openai: ['cursor', 'anthropic/claude-sonnet-5'],
    cursor: ['anthropic/claude-sonnet-5', 'openai/gpt-5.1'],
    devin: ['anthropic/claude-sonnet-5', 'openai/gpt-5.1', 'cursor'], // Devin can fallback to normal providers
  }

  return { providers, modelPatterns, fallbacks }
}

function buildConfig(): GatewayConfig {
  const defaults = buildDefaults()
  const raw = loadRawConfig()

  let providers = defaults.providers
  let modelPatterns = defaults.modelPatterns
  let fallbacks = defaults.fallbacks
  let defaultProvider = 'anthropic'

  if (raw) {
    if (raw.providers) {
      // File providers override/extend built-ins by name.
      providers = { ...providers }
      for (const [key, rawProvider] of Object.entries(raw.providers)) {
        providers[key] = expandProvider(key, rawProvider)
      }
    }
    if (raw.modelPatterns) {
      modelPatterns = raw.modelPatterns.map((p) => ({
        match: new RegExp(p.match),
        provider: p.provider,
      }))
    }
    if (raw.fallbacks) fallbacks = raw.fallbacks
    if (raw.defaultProvider) defaultProvider = raw.defaultProvider
  }

  // Drop credentialed providers whose key expanded empty (e.g. ${OPENAI_API_KEY}
  // referenced in the file but env unset) so routing errors are clean. Keyless
  // providers (apiKey undefined, e.g. Ollama) and OAuth-based providers are kept.
  for (const [key, provider] of Object.entries(providers)) {
    if (provider.kind === 'anthropic-oauth' || provider.kind === 'devin-oauth') continue
    if (provider.apiKey !== undefined && provider.apiKey === '') {
      delete providers[key]
    }
  }

  // Update default provider if the original one was dropped
  if (!providers[defaultProvider]) {
    const availableProviders = Object.keys(providers)
    defaultProvider = availableProviders.length > 0 ? availableProviders[0] : 'anthropic'
  }

  return { defaultProvider, providers, modelPatterns, fallbacks }
}

let cached: GatewayConfig | null = null

export function getGatewayConfig(): GatewayConfig {
  if (!cached) cached = buildConfig()
  return cached
}

export function hasProvider(name: string): boolean {
  return name in getGatewayConfig().providers
}

// Used by the cursor BYOK key-probe narrowing: once any real OpenAI-serving
// provider exists, we must stop hijacking gpt-4o requests as key checks.
export function hasOpenAICompatibleProvider(): boolean {
  return Object.values(getGatewayConfig().providers).some(
    (p) => p.kind === 'openai-compatible' || p.kind === 'cursor',
  )
}
