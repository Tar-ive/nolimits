import { Hono, Context } from 'hono'
import { stream } from 'hono/streaming'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAccessToken } from './auth/oauth-manager'
import {
  login as oauthLogin,
  logout as oauthLogout,
  generateAuthSession,
  handleOAuthCallback,
} from './auth/oauth-flow'
import { corsPreflightHandler, corsMiddleware } from './utils/cors-bypass'
import {
  isCursorKeyCheck,
  createCursorBypassResponse,
} from './utils/cursor-byok-bypass'
import { getGatewayConfig } from './gateway/config'
import { enforceCacheControlLimit } from './utils/openai-to-anthropic-request'
import { stripThinkingSuffix, resolveChain, type Effort, type Route } from './gateway/router'
import { dispatch } from './gateway/dispatch'
import { ACPWebSocketHandler } from './devin/acp-websocket'
import {
  handleGetChatMessage,
  passthroughCodeium,
  GETCHATMESSAGE_PATH,
} from './gateway/devin/ide-handler'
import { getGlobalSessionManager } from './devin/session-manager'
import {
  getCodexCredentials,
  parseCodexAuthJSON,
  removeCodexCredentials,
  setCodexCredentials,
} from './auth/codex-auth'
import { getDevinToken } from './auth/devin-token-store'
import { getAntigravityCredentials, getOpenCodeSession } from './auth/provider-auth'
import { fetchAntigravityUsage, fetchAnthropicUsage, fetchCodexUsage, fetchCursorUsage, fetchOpenCodeUsage } from './usage/provider-usage'
import {
  login as devinLogin,
  logout as devinLogout,
  handleDevinTokenSubmit,
} from './auth/devin-auth-flow'
import type {
  AnthropicRequestBody,
  ErrorResponse,
  SuccessResponse,
  ModelsListResponse,
  ModelInfo,
} from './types'

// Static files are served by Vercel, not needed here

const app = new Hono()

// Initialize ACP WebSocket server for Devin CLI handoff protocol
let acpWebSocketHandler: ACPWebSocketHandler | null = null
if (process.env.ENABLE_WEBSOCKET === 'true') {
  // Only run WebSocket server if explicitly enabled (for Railway)
  try {
    const wsPort = Number(process.env.WEBSOCKET_PORT) || 9096
    acpWebSocketHandler = new ACPWebSocketHandler(wsPort)
    console.log(`ACP WebSocket server initialized on port ${wsPort}`)
  } catch (error) {
    console.error('Failed to initialize ACP WebSocket server:', error)
  }
}

// Handle CORS preflight requests for all routes
app.options('*', corsPreflightHandler)

// Also add CORS headers to all responses
app.use('*', corsMiddleware)

// Devin Desktop (Cascade) support: when codeium.apiServerUrl points here, redirect
// the agent's GetChatMessage inference to OpenCode and transparently proxy every
// other exa.* Codeium call through to the real backend.
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (path === GETCHATMESSAGE_PATH) return handleGetChatMessage(c)
  if (path.startsWith('/exa.')) return passthroughCodeium(c)
  return next()
})

const indexHtmlPath = join(process.cwd(), 'public', 'index.html')
let cachedIndexHtml: string | null = null

const getIndexHtml = async () => {
  if (!cachedIndexHtml) {
    cachedIndexHtml = await readFile(indexHtmlPath, 'utf-8')
  }
  return cachedIndexHtml
}

// Health check endpoint for Railway
app.get('/health', async (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

// Root route is handled by serving public/index.html directly
app.get('/', async (c) => {
  const html = await getIndexHtml()
  return c.html(html)
})

app.get('/index.html', async (c) => {
  const html = await getIndexHtml()
  return c.html(html)
})

// New OAuth start endpoint for UI
app.post('/auth/oauth/start', async (c: Context) => {
  try {
    const { authUrl, sessionId } = await generateAuthSession()

    return c.json({
      success: true,
      authUrl,
      sessionId,
    })
  } catch (error) {
    return c.json<ErrorResponse>(
      {
        error: 'Failed to start OAuth flow',
        message: (error as Error).message,
      },
      500,
    )
  }
})

// New OAuth callback endpoint for UI
app.post('/auth/oauth/callback', async (c: Context) => {
  try {
    const body = await c.req.json()
    const { code } = body

    if (!code) {
      return c.json<ErrorResponse>(
        {
          error: 'Missing OAuth code',
          message: 'OAuth code is required',
        },
        400,
      )
    }

    // Extract verifier from code if it contains #
    const splits = code.split('#')
    const verifier = splits[1] || ''

    await handleOAuthCallback(code, verifier)

    return c.json<SuccessResponse>({
      success: true,
      message: 'OAuth authentication successful',
    })
  } catch (error) {
    return c.json<ErrorResponse>(
      {
        error: 'OAuth callback failed',
        message: (error as Error).message,
      },
      500,
    )
  }
})

app.post('/auth/login/start', async (c: Context) => {
  try {
    console.log('\n Starting OAuth authentication flow...')
    const result = await oauthLogin()
    if (result) {
      return c.json<SuccessResponse>({
        success: true,
        message: 'OAuth authentication successful',
      })
    } else {
      return c.json<SuccessResponse>(
        { success: false, message: 'OAuth authentication failed' },
        401,
      )
    }
  } catch (error) {
    return c.json<SuccessResponse>(
      { success: false, message: (error as Error).message },
      500,
    )
  }
})

app.get('/auth/logout', async (c: Context) => {
  try {
    await oauthLogout()
    return c.json<SuccessResponse>({
      success: true,
      message: 'Logged out successfully',
    })
  } catch (error) {
    return c.json<SuccessResponse>(
      { success: false, message: (error as Error).message },
      500,
    )
  }
})

app.get('/auth/status', async (c: Context) => {
  try {
    const token = await getAccessToken()
    return c.json({ authenticated: !!token })
  } catch (error) {
    return c.json({ authenticated: false })
  }
})

// Devin authentication endpoints
app.get('/devin-auth', async (c: Context) => {
  const htmlPath = join(process.cwd(), 'public', 'devin-auth.html')
  const html = await readFile(htmlPath, 'utf-8')
  return c.html(html)
})

app.post('/auth/devin/callback', async (c: Context) => {
  try {
    const body = await c.req.json()
    const { token } = body

    if (!token) {
      return c.json<ErrorResponse>(
        {
          error: 'Missing Devin token',
          message: 'Devin token is required',
        },
        400,
      )
    }

    await handleDevinTokenSubmit(token, 'web-session')

    return c.json<SuccessResponse>({
      success: true,
      message: 'Devin authentication successful',
    })
  } catch (error) {
    return c.json<ErrorResponse>(
      {
        error: 'Devin authentication failed',
        message: (error as Error).message,
      },
      500,
    )
  }
})

app.get('/auth/devin/status', async (c: Context) => {
  try {
    const token = await getDevinToken()
    return c.json({ authenticated: !!token })
  } catch (error) {
    return c.json({ authenticated: false })
  }
})

app.get('/auth/devin/logout', async (c: Context) => {
  try {
    await devinLogout()
    return c.json<SuccessResponse>({
      success: true,
      message: 'Logged out successfully',
    })
  } catch (error) {
    return c.json<SuccessResponse>(
      { success: false, message: (error as Error).message },
      500,
    )
  }
})

// Store a Cursor WorkosCursorSessionToken (for Vercel; locally CURSOR_SESSION_TOKEN
// env is enough). Kept lightweight — reuses the same Redis-backed auth store.
app.post('/auth/cursor/token', async (c: Context) => {
  try {
    const { token } = await c.req.json()
    if (!token || typeof token !== 'string') {
      return c.json<ErrorResponse>(
        { error: 'Missing token', message: 'token is required' },
        400,
      )
    }
    const { setCursorToken } = await import('./gateway/cursor-auth')
    await setCursorToken(token)
    return c.json<SuccessResponse>({
      success: true,
      message: 'Cursor session token saved',
    })
  } catch (error) {
    return c.json<ErrorResponse>(
      { error: 'Failed to save Cursor token', message: (error as Error).message },
      500,
    )
  }
})

app.get('/auth/cursor/status', async (c: Context) => {
  const { getCursorToken } = await import('./gateway/cursor-auth')
  return c.json({ authenticated: Boolean(await getCursorToken()) })
})

app.get('/auth/cursor/logout', async (c: Context) => {
  const { removeCursorToken } = await import('./gateway/cursor-auth')
  await removeCursorToken()
  return c.json<SuccessResponse>({ success: true, message: 'Cursor disconnected' })
})

// Codex CLI auth import. This avoids embedding an undocumented OAuth client in
// the iOS app. Treat imported auth.json as a password and send it only to a
// connector instance you control.
app.post('/auth/codex/import', async (c: Context) => {
  try {
    const credentials = parseCodexAuthJSON(await c.req.json())
    await setCodexCredentials(credentials)
    return c.json<SuccessResponse>({ success: true, message: 'Codex credentials imported' })
  } catch (error) {
    return c.json<ErrorResponse>({ error: 'Codex import failed', message: (error as Error).message }, 400)
  }
})

app.get('/auth/codex/status', async (c: Context) => {
  return c.json({ authenticated: Boolean(await getCodexCredentials()) })
})

app.get('/auth/codex/logout', async (c: Context) => {
  await removeCodexCredentials()
  return c.json<SuccessResponse>({ success: true, message: 'Codex disconnected' })
})

app.get('/auth/antigravity/status', async (c: Context) => {
  return c.json({ authenticated: Boolean(await getAntigravityCredentials()) })
})

app.get('/auth/opencode/status', async (c: Context) => {
  return c.json({ authenticated: Boolean(await getOpenCodeSession()) })
})

app.get('/usage/anthropic', async (c: Context) => {
  try {
    return c.json(await fetchAnthropicUsage())
  } catch (error) {
    return c.json<ErrorResponse>({ error: 'Anthropic usage unavailable', message: (error as Error).message }, 502)
  }
})

app.get('/usage/codex', async (c: Context) => {
  try {
    return c.json(await fetchCodexUsage())
  } catch (error) {
    return c.json<ErrorResponse>({ error: 'Codex usage unavailable', message: (error as Error).message }, 502)
  }
})

app.get('/usage/cursor', async (c: Context) => {
  try {
    return c.json(await fetchCursorUsage())
  } catch (error) {
    return c.json<ErrorResponse>({ error: 'Cursor usage unavailable', message: (error as Error).message }, 502)
  }
})

app.get('/usage/antigravity', async (c: Context) => {
  try {
    return c.json(await fetchAntigravityUsage())
  } catch (error) {
    return c.json<ErrorResponse>({ error: 'Antigravity usage unavailable', message: (error as Error).message }, 502)
  }
})

app.get('/usage/opencode', async (c: Context) => {
  try {
    return c.json(await fetchOpenCodeUsage())
  } catch (error) {
    return c.json<ErrorResponse>({ error: 'OpenCode usage unavailable', message: (error as Error).message }, 502)
  }
})

// Model retrieve — some clients validate a model by fetching it. Both the bare
// (/v1/models/:modelId) and provider-prefixed (/v1/models/:provider/:modelId)
// forms are supported; Hono params don't span '/', so the two-segment id needs
// its own route.
app.get('/v1/models/:provider/:modelId', async (c: Context) => {
  const provider = c.req.param('provider')!
  const modelId = c.req.param('modelId')!
  return c.json<ModelInfo>({
    id: `${provider}/${modelId}`,
    object: 'model',
    created: 0,
    owned_by: provider,
  })
})

app.get('/v1/models/:modelId', async (c: Context) => {
  const modelId = c.req.param('modelId')!
  return c.json<ModelInfo>({
    id: modelId,
    object: 'model',
    created: 0,
    owned_by: 'anthropic',
  })
})

// Log unmatched routes so unsupported client endpoints show up in Vercel logs
app.notFound((c) => {
  const path = c.req.path
  
  // Handle Devin gRPC endpoints here as a catch-all
  if (path.startsWith('/exa.')) {
    console.log(`Devin gRPC request (notFound): ${c.req.method} ${path}`)
    return c.json({ success: true })
  }
  
  console.error(`404 for ${c.req.method} ${c.req.path}`)
  return c.json(
    {
      error: {
        message: `Unknown endpoint: ${c.req.method} ${c.req.path}`,
        type: 'invalid_request_error',
      },
    },
    404,
  )
})

app.get('/v1/models', async (c: Context) => {
  const models: ModelInfo[] = []
  const seen = new Set<string>()
  const add = (info: ModelInfo) => {
    if (seen.has(info.id)) return
    seen.add(info.id)
    models.push(info)
  }

  // Anthropic models from models.dev (best-effort — a failure here no longer
  // blocks the configured provider aliases below).
  try {
    const response = await fetch('https://models.dev/api.json', {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': '@anthropic-ai/sdk 1.2.12 node/22.13.1',
      },
    })
    if (response.ok) {
      const modelsData = (await response.json()) as any
      const anthropicModels = modelsData?.anthropic?.models
      if (anthropicModels) {
        for (const [modelId, modelData] of Object.entries<any>(anthropicModels)) {
          const releaseDate = modelData.release_date || '1970-01-01'
          add({
            id: modelId,
            object: 'model',
            created: Math.floor(new Date(releaseDate).getTime() / 1000),
            owned_by: 'anthropic',
          })
        }
      }
    } else {
      console.error('models.dev error:', await response.text())
    }
  } catch (error) {
    console.error('models.dev fetch failed:', (error as Error).message)
  }

  // Append each configured provider's static models as bare + provider/-prefixed
  // ids, so fast-mode aliases (e.g. cursor/claude-sonnet-5, openai/gpt-5.1)
  // appear in Cursor's model picker.
  const config = getGatewayConfig()
  for (const provider of Object.values(config.providers)) {
    if (!provider.models) continue
    for (const model of provider.models) {
      add({ id: model, object: 'model', created: 0, owned_by: provider.name })
      add({
        id: `${provider.name}/${model}`,
        object: 'model',
        created: 0,
        owned_by: provider.name,
      })
    }
  }

  models.sort((a, b) => b.created - a.created)

  return c.json<ModelsListResponse>({ object: 'list', data: models })
})

// Claude Code (Anthropic-format) requests are proxied raw to the Anthropic
// upstream with no format conversion and no failover — mirrors the original
// non-transform path.
async function rawAnthropicPassthrough(
  c: Context,
  body: AnthropicRequestBody,
  route: Route,
  effort: Effort | undefined,
  isStreaming: boolean,
): Promise<Response> {
  body.model = route.upstreamModel
  if (effort && !(body as any).output_config) {
    ;(body as any).output_config = { effort }
  }

  // Anthropic hard-rejects >4 cache_control blocks; cap here too so raw
  // Anthropic-format clients can't trip it.
  enforceCacheControlLimit(body)

  const oauthToken = await getAccessToken()
  if (!oauthToken) {
    return c.json<ErrorResponse>(
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
    'anthropic-beta': 'oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
    'anthropic-version': '2023-06-01',
    'user-agent': '@anthropic-ai/sdk 1.2.12 node/22.13.1',
    accept: isStreaming ? 'text/event-stream' : 'application/json',
    'accept-encoding': 'gzip, deflate',
  }

  const response = await fetch(`${route.provider.baseUrl}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const error = await response.text()
    console.error('API Error:', error)
    if (response.status === 401) {
      return c.json<ErrorResponse>(
        {
          error: 'Authentication failed',
          message:
            'OAuth token may be expired. Please re-authenticate using /auth/login/start',
          details: error,
        },
        401,
      )
    }
    return new Response(error, {
      status: response.status,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  if (isStreaming) {
    response.headers.forEach((value, key) => {
      const k = key.toLowerCase()
      if (
        k !== 'content-encoding' &&
        k !== 'content-length' &&
        k !== 'transfer-encoding'
      ) {
        c.header(key, value)
      }
    })

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    return stream(c, async (s) => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          await s.write(decoder.decode(value, { stream: true }))
        }
      } catch (error) {
        console.error('Stream error:', error)
      } finally {
        reader.releaseLock()
      }
    })
  }

  const responseData = (await response.json()) as any
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'content-encoding') c.header(key, value)
  })
  return c.json(responseData)
}

const messagesFn = async (c: Context) => {
  const body: AnthropicRequestBody = await c.req.json()
  const isStreaming = body.stream === true

  // Strip Cursor's "thinking" suffix (e.g. claude-sonnet-5-thinking-high) and
  // capture the effort level for all providers, before routing.
  let effort: Effort | undefined
  if (typeof body.model === 'string') {
    const stripped = stripThinkingSuffix(body.model)
    body.model = stripped.model
    effort = stripped.effort
  }

  // Proxy API key check (the proxy's own API_KEY, not any upstream credential).
  // Accepts Authorization: Bearer (Cursor, ANTHROPIC_AUTH_TOKEN) and x-api-key
  // (Anthropic SDKs configured via ANTHROPIC_API_KEY).
  // 
  // If API_KEY is not set, allow normal Claude Code to work without proxy authentication
  // This ensures normal Claude Code sessions bypass the proxy entirely
  const apiKey =
    c.req.header('authorization')?.split(' ')?.[1] ?? c.req.header('x-api-key')
  const hasApiKeyConfigured = !!process.env.API_KEY
  
  const authState = !apiKey ? 'none' : apiKey === process.env.API_KEY ? 'ok' : 'MISMATCH'
  console.log(
    `req ${c.req.path} model=${body.model} stream=${body.stream === true} auth=${authState} hasApiKey=${hasApiKeyConfigured} ua=${(c.req.header('user-agent') || '-').slice(0, 40)}`,
  )
  
  // Only enforce API key authentication if API_KEY is configured
  // If no API_KEY is set, return error to ensure proxy doesn't interfere with normal Claude Code
  if (!hasApiKeyConfigured) {
    console.log('No API_KEY configured - proxy is not active. Please configure API_KEY to use the proxy.')
    return c.json<ErrorResponse>(
      {
        error: 'Proxy not configured',
        message: 'The proxy requires API_KEY to be configured. Without it, the proxy does not function. Normal Claude Code should work directly without the proxy.',
      },
      503,
    )
  }
  
  if (apiKey && apiKey !== process.env.API_KEY) {
    return c.json(
      {
        error: 'Authentication required',
        message: 'Please authenticate use the API key from the .env file',
      },
      401,
    )
  }

  // Bypass Cursor's OpenAI-key validation probe. Gate on whether gpt-4o is
  // actually servable — not on any openai-compatible provider existing (e.g.
  // OpenCode registers as one but serves no gpt models; a probe routed there
  // 400s and Cursor disables the whole BYOK override).
  if (isCursorKeyCheck(body, resolveChain('gpt-4o').length > 0)) {
    return c.json(createCursorBypassResponse())
  }

  try {
    // Anthropic-format = the Claude Code CLI pointed at this proxy (system[0]
    // carries the Claude Code marker). Everything else is OpenAI-format (Cursor).
    const isAnthropicFormat = !!body.system?.[0]?.text?.includes(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    )

    const chain = resolveChain(body.model)
    if (chain.length === 0) {
      return c.json<ErrorResponse>(
        {
          error: 'Provider not configured',
          message: `No provider is registered for model "${body.model}". Set the relevant credential (e.g. OPENAI_API_KEY or CURSOR_SESSION_TOKEN) or add the provider to gateway.config.json.`,
        },
        400,
      )
    }

    if (isAnthropicFormat) {
      const route = chain[0]
      if (route.provider.kind !== 'anthropic-oauth') {
        return c.json(
          {
            error: {
              message: `Anthropic-format (Claude Code) requests can only be routed to an anthropic-oauth provider, but "${body.model}" resolves to "${route.provider.name}".`,
              type: 'unsupported_route',
            },
          },
          501,
        )
      }
      return rawAnthropicPassthrough(c, body, route, effort, isStreaming)
    }

    // OpenAI-format (the Cursor case) — route through the failover dispatcher.
    return dispatch(c, body, chain, effort)
  } catch (error) {
    console.error('Proxy error:', error)
    return c.json<ErrorResponse>(
      { error: 'Proxy error', details: (error as Error).message },
      500,
    )
  }
}

app.post('/v1/chat/completions', messagesFn)
app.post('/v1/messages', messagesFn)

// Devin CLI specific endpoint - OpenAI-compatible API for Devin
app.post('/devin/v1/chat/completions', async (c: Context) => {
  try {
    const body: AnthropicRequestBody = await c.req.json()
    const isStreaming = body.stream === true

    // Check if user is authenticated with Devin
    const devinToken = await getAccessToken()
    if (!devinToken) {
      return c.json<ErrorResponse>(
        {
          error: 'Authentication required',
          message: 'Please authenticate with Devin first. Visit /devin-auth for instructions.',
        },
        401,
      )
    }

    // Add Devin-specific routing by prefixing model with "devin-"
    if (typeof body.model === 'string' && !body.model.startsWith('devin-')) {
      body.model = `devin-${body.model}`
    }

    // Create a new context with the modified body
    // We need to process this through the standard gateway
    const chain = resolveChain(body.model)
    if (chain.length === 0) {
      return c.json<ErrorResponse>(
        {
          error: 'Provider not configured',
          message: `No provider is registered for model "${body.model}".`,
        },
        400,
      )
    }

    // Process through the gateway dispatcher
    return dispatch(c, body, chain, undefined)
  } catch (error) {
    console.error('Devin endpoint error:', error)
    return c.json<ErrorResponse>(
      { error: 'Devin endpoint error', details: (error as Error).message },
      500,
    )
  }
})

// Devin health check endpoint
app.get('/devin/health', async (c: Context) => {
  const token = await getAccessToken()
  return c.json({
    status: 'ok',
    authenticated: !!token,
    providers: Object.keys(getGatewayConfig().providers),
  })
})

// Devin models endpoint - OpenAI-compatible
app.get('/devin/v1/models', async (c: Context) => {
  const config = getGatewayConfig()
  const devinProvider = config.providers.devin

  if (!devinProvider) {
    return c.json<ModelsListResponse>({ object: 'list', data: [] })
  }

  const models: ModelInfo[] = []
  if (devinProvider.models) {
    for (const model of devinProvider.models) {
      models.push({
        id: model,
        object: 'model',
        created: 0,
        owned_by: 'devin',
      })
      // Also add with devin- prefix
      models.push({
        id: `devin-${model}`,
        object: 'model',
        created: 0,
        owned_by: 'devin',
      })
    }
  }

  return c.json<ModelsListResponse>({ object: 'list', data: models })
})

// Devin CLI specific endpoint - OpenAI-compatible API for Devin
app.post('/devin/v1/chat/completions', async (c: Context) => {
  try {
    const body: AnthropicRequestBody = await c.req.json()
    const isStreaming = body.stream === true

    // Check if user is authenticated with Claude (Devin CLI will use Claude Max)
    const oauthToken = await getAccessToken()
    if (!oauthToken) {
      return c.json<ErrorResponse>(
        {
          error: 'Authentication required',
          message: 'Please authenticate with Claude first. Visit /auth/login for instructions.',
        },
        401,
      )
    }

    // Add Devin-specific routing by prefixing model with "devin-"
    if (typeof body.model === 'string' && !body.model.startsWith('devin-')) {
      body.model = `devin-${body.model}`
    }

    // Create a new context with the modified body
    // We need to process this through the standard gateway
    const chain = resolveChain(body.model)
    if (chain.length === 0) {
      return c.json<ErrorResponse>(
        {
          error: 'Provider not configured',
          message: `No provider is registered for model "${body.model}".`,
        },
        400,
      )
    }

    // Process through the gateway dispatcher
    return dispatch(c, body, chain, undefined)
  } catch (error) {
    console.error('Devin endpoint error:', error)
    return c.json<ErrorResponse>(
      { error: 'Devin endpoint error', details: (error as Error).message },
      500,
    )
  }
})

// Devin health check endpoint
app.get('/devin/health', async (c: Context) => {
  const token = await getAccessToken()
  return c.json({
    status: 'ok',
    authenticated: !!token,
    providers: Object.keys(getGatewayConfig().providers),
  })
})

// Devin models endpoint - OpenAI-compatible
app.get('/devin/v1/models', async (c: Context) => {
  const config = getGatewayConfig()
  const devinProvider = config.providers.devin

  if (!devinProvider) {
    return c.json<ModelsListResponse>({ object: 'list', data: [] })
  }

  const models: ModelInfo[] = []
  if (devinProvider.models) {
    for (const model of devinProvider.models) {
      models.push({
        id: model,
        object: 'model',
        created: 0,
        owned_by: 'devin',
      })
      // Also add with devin- prefix
      models.push({
        id: `devin-${model}`,
        object: 'model',
        created: 0,
        owned_by: 'devin',
      })
    }
  }

  return c.json<ModelsListResponse>({ object: 'list', data: models })
})

// Devin session token generation endpoint
app.post('/devin/session/token', async (c: Context) => {
  try {
    const sessionManager = getGlobalSessionManager()
    const token = sessionManager.generateSessionToken()
    
    return c.json({
      success: true,
      token,
      expires_in: 86400, // 24 hours
    })
  } catch (error) {
    return c.json<ErrorResponse>(
      {
        error: 'Failed to generate session token',
        message: (error as Error).message,
      },
      500,
    )
  }
})

// ACP WebSocket upgrade endpoint for Devin CLI
app.get('/acp/live', async (c: Context) => {
  // This is a placeholder - the actual WebSocket handling is done by the separate WebSocket server
  // But we need to respond to the HTTP GET request to indicate WebSocket support
  return c.text('WebSocket endpoint - use ws://localhost:9096/acp/live?token=YOUR_TOKEN', 426)
})

// Devin webapp endpoint (for web app related calls)
app.all('/webapp/*', async (c: Context) => {
  const path = c.req.path
  const method = c.req.method
  
  console.log(`Devin Webapp request: ${method} ${path}`)
  
  // For now, proxy webapp requests to the real Devin webapp
  // In production, you might want to handle these differently
  const targetUrl = `https://app.devin.ai${path.replace('/webapp', '')}`
  const response = await fetch(targetUrl, {
    method: method as any,
    headers: {
      'Content-Type': 'application/json',
    },
    body: method !== 'GET' ? await c.req.text() : undefined,
  })

  const responseData = await response.text()
  return new Response(responseData, {
    status: response.status,
    headers: { 'Content-Type': 'text/html' },
  })
})

const port = Number(process.env.PORT) || 9095

// Named export for the Vercel handler (api/index.ts).
export { app }

// Default export drives Bun's auto-serve: `bun src/server.ts` listens on `port`.
// (Bun reads `port` + `fetch` off the default export.)
export default { port, fetch: app.fetch }

// Start HTTP server for Node.js environments (Railway, etc.)
if (typeof Bun === 'undefined') {
  // Running in Node.js, not Bun
  const { serve } = require('@hono/node-server')
  console.log(`Starting Node.js server on port ${port}`)
  serve({
    fetch: app.fetch,
    port,
  })
}
