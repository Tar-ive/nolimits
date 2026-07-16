import { Redis } from '@upstash/redis'
import { getAccessToken } from '../auth/oauth-manager'
import { getValidCodexCredentials } from '../auth/codex-auth'
import { getCursorSessionToken } from '../gateway/cursor-auth'
import { getAntigravityCredentials, getOpenCodeSession, setAntigravityCredentials } from '../auth/provider-auth'

export interface UsageWindow {
  label: string
  usedPercent: number
  resetAt?: string
  windowSeconds?: number
  kind: 'session' | 'weekly' | 'weeklyScoped'
}

export interface ProviderUsageSnapshot {
  providerId: 'anthropic' | 'codex' | 'cursor' | 'antigravity' | 'opencode'
  windows: UsageWindow[]
  lastUpdated: string
  accountLabel?: string
  credits?: Array<{ available: number; expiresAt?: string }>
  rateLimitStatus?: { allowed: boolean; limitReached: boolean }
  resetCredits?: { availableCount: number }
  experimental: true
}

type JSONMap = Record<string, any>

const usageRedis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null
const memoryCache = new Map<string, { value: ProviderUsageSnapshot; fetchedAt: number }>()

async function cachedUsage(provider: ProviderUsageSnapshot['providerId'], load: () => Promise<ProviderUsageSnapshot>) {
  const key = `usage:cache:${provider}`
  const stored = memoryCache.get(provider) ?? await usageRedis?.get<{ value: ProviderUsageSnapshot; fetchedAt: number }>(key) ?? undefined
  if (stored && Date.now() - stored.fetchedAt < 30_000) return stored.value
  try {
    const value = await load()
    const entry = { value, fetchedAt: Date.now() }
    memoryCache.set(provider, entry)
    await usageRedis?.set(key, entry, { ex: 86_400 })
    return value
  } catch (error) {
    if (stored) return stored.value
    throw error
  }
}

function window(label: string, value: JSONMap | undefined, kind: UsageWindow['kind']): UsageWindow | null {
  if (!value) return null
  const used = value.used_percent ?? value.utilization ?? value.usedPercent ?? value.percent
  if (typeof used !== 'number') return null
  const rawReset = value.reset_at ?? value.resets_at ?? value.resetAt
  const resetAt = typeof rawReset === 'number'
    ? new Date(rawReset * (rawReset < 1e12 ? 1000 : 1)).toISOString()
    : rawReset
  return {
    label,
    usedPercent: Math.max(0, Math.min(100, used)),
    resetAt,
    windowSeconds: value.limit_window_seconds ?? value.window_seconds ?? value.windowSeconds,
    kind,
  }
}

export function normalizeCodexUsage(data: JSONMap, accountLabel?: string): ProviderUsageSnapshot {
  const rate = data.rate_limit ?? data.rateLimit ?? data
  const codexWindow = (value: JSONMap | undefined) => {
    const seconds = Number(value?.limit_window_seconds ?? value?.window_seconds ?? value?.windowSeconds)
    const weekly = seconds >= 6 * 86_400
    const label = weekly ? 'Weekly' : seconds > 0 ? `${Math.round(seconds / 3_600)}-hour session` : 'Session'
    return window(label, value, weekly ? 'weekly' : 'session')
  }
  const windows = [codexWindow(rate.primary_window ?? rate.primaryWindow), codexWindow(rate.secondary_window ?? rate.secondaryWindow)]
    .filter((item): item is UsageWindow => Boolean(item))
  const rawCredits = data.credits?.grants ?? data.reset_credits ?? []
  const credits = Array.isArray(rawCredits)
    ? rawCredits.map((item: JSONMap) => ({
        available: Number(item.available ?? item.balance ?? 0),
        expiresAt: typeof (item.expires_at ?? item.expiresAt) === 'number'
          ? new Date((item.expires_at ?? item.expiresAt) * 1000).toISOString()
          : item.expires_at ?? item.expiresAt,
      }))
    : undefined
  const status = data.rate_limit ?? data.rateLimit
  const resetCredits = data.rate_limit_reset_credits ?? data.rateLimitResetCredits
  return {
    providerId: 'codex', windows, lastUpdated: new Date().toISOString(), accountLabel, credits,
    rateLimitStatus: status ? { allowed: Boolean(status.allowed), limitReached: Boolean(status.limit_reached ?? status.limitReached) } : undefined,
    resetCredits: typeof (resetCredits?.available_count ?? resetCredits?.availableCount) === 'number'
      ? { availableCount: resetCredits.available_count ?? resetCredits.availableCount }
      : undefined,
    experimental: true,
  }
}

export function normalizeAnthropicUsage(data: JSONMap): ProviderUsageSnapshot {
  const legacy = [
    window('5 hour', data.five_hour, 'session'),
    window('7 day', data.seven_day, 'weekly'),
    window('7 day Sonnet', data.seven_day_sonnet, 'weeklyScoped'),
    window('7 day Opus', data.seven_day_opus, 'weeklyScoped'),
  ].filter((item): item is UsageWindow => Boolean(item))
  const modern = Array.isArray(data.limits) ? data.limits.flatMap((item: JSONMap): UsageWindow[] => {
    const model = item.scope?.model?.display_name
    const label = item.group === 'session' ? '5 hour' : model ? `7 day · ${model}` : '7 day'
    const normalized = window(label, item, item.group === 'session' ? 'session' : model ? 'weeklyScoped' : 'weekly')
    return normalized ? [normalized] : []
  }) : []
  const windows = modern.length ? modern : legacy
  return { providerId: 'anthropic', windows, lastUpdated: new Date().toISOString(), experimental: true }
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const CODE_ASSIST = 'https://cloudcode-pa.googleapis.com/v1internal'

async function antigravityAccessToken() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error('Antigravity OAuth client is not configured')
  const credentials = await getAntigravityCredentials()
  if (!credentials) throw new Error('Antigravity is not connected')
  if (credentials.expiryDate > Date.now() + 60_000) return credentials.accessToken
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: credentials.refreshToken, grant_type: 'refresh_token' }),
  })
  if (!response.ok) throw new Error(`Antigravity token refresh failed (${response.status})`)
  const token = await response.json() as JSONMap
  const updated = { ...credentials, accessToken: token.access_token,
    expiryDate: Date.now() + Number(token.expires_in ?? 3600) * 1000,
    scope: token.scope ?? credentials.scope, tokenType: token.token_type ?? credentials.tokenType }
  await setAntigravityCredentials(updated)
  return updated.accessToken
}

export async function fetchAntigravityUsage(): Promise<ProviderUsageSnapshot> {
  return cachedUsage('antigravity', async () => {
    const accessToken = await antigravityAccessToken()
    const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }
    const bootstrap = await fetch(`${CODE_ASSIST}:loadCodeAssist`, {
      method: 'POST', headers,
      body: JSON.stringify({ metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }),
    })
    if (!bootstrap.ok) throw new Error(`Antigravity account request failed (${bootstrap.status})`)
    const account = await bootstrap.json() as JSONMap
    const project = account.cloudaicompanionProject
    if (!project) throw new Error('Antigravity did not return a project')
    const response = await fetch(`${CODE_ASSIST}:retrieveUserQuota`, {
      method: 'POST', headers, body: JSON.stringify({ project }),
    })
    if (!response.ok) throw new Error(`Antigravity quota request failed (${response.status})`)
    const data = await response.json() as JSONMap
    const priority = ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-2.5-pro']
    const buckets = [...(data.buckets ?? [])].sort((a: JSONMap, b: JSONMap) => {
      const rank = (model: string) => { const value = priority.indexOf(model); return value < 0 ? priority.length : value }
      return rank(String(a.modelId ?? a.model)) - rank(String(b.modelId ?? b.model))
    })
    const windows: UsageWindow[] = buckets.flatMap((bucket: JSONMap) => {
      if (typeof bucket.remainingFraction !== 'number') return []
      const rawModel = String(bucket.modelId ?? bucket.model ?? 'Gemini')
      const label = rawModel.replace(/^gemini-/i, 'Gemini ').replaceAll('-', ' ')
        .replace(/\bpreview\b/i, '').replace(/\s+/g, ' ').trim().replace(/\b\w/g, value => value.toUpperCase())
      return [{ label, usedPercent: Math.max(0, Math.min(100, (1 - bucket.remainingFraction) * 100)),
        resetAt: bucket.resetTime, windowSeconds: 86_400, kind: 'weeklyScoped' as const }]
    })
    const accountLabel = account.paidTier?.name ?? account.currentTier?.name ?? account.currentTier?.displayName
    return { providerId: 'antigravity', windows, lastUpdated: new Date().toISOString(), accountLabel, experimental: true }
  })
}

function openCodeWindow(html: string, key: string, label: string, kind: UsageWindow['kind']): UsageWindow | null {
  const block = html.match(new RegExp(`${key}:\\$R\\[\\d+\\]=\\{([^}]+)\\}`))?.[1]
  if (!block || !/status:"ok"/.test(block)) return null
  const usage = Number(block.match(/usagePercent:([\d.]+)/)?.[1])
  const resetIn = Number(block.match(/resetInSec:(\d+)/)?.[1])
  if (!Number.isFinite(usage)) return null
  return { label, usedPercent: Math.max(0, Math.min(100, usage)),
    resetAt: Number.isFinite(resetIn) ? new Date(Date.now() + resetIn * 1000).toISOString() : undefined, kind }
}

export async function fetchOpenCodeUsage(): Promise<ProviderUsageSnapshot> {
  return cachedUsage('opencode', async () => {
    const session = await getOpenCodeSession()
    if (!session) throw new Error('OpenCode Go dashboard is not connected')
    const response = await fetch(`https://opencode.ai/workspace/${session.workspaceId}/go`, {
      headers: { cookie: `auth=${session.cookie}`, 'user-agent': 'Mozilla/5.0' }, redirect: 'manual',
    })
    if (!response.ok || response.status >= 300) throw new Error('OpenCode dashboard session expired; sync again from your Mac')
    const html = await response.text()
    const windows = [
      openCodeWindow(html, 'rollingUsage', '5 hour', 'session'),
      openCodeWindow(html, 'weeklyUsage', 'Weekly', 'weekly'),
      openCodeWindow(html, 'monthlyUsage', 'Monthly', 'weeklyScoped'),
    ].filter((item): item is UsageWindow => Boolean(item))
    if (!windows.length) throw new Error('OpenCode dashboard did not return usage')
    return { providerId: 'opencode', windows, lastUpdated: new Date().toISOString(), accountLabel: 'Go', experimental: true }
  })
}

export function normalizeCursorUsage(data: JSONMap, accountLabel?: string): ProviderUsageSnapshot {
  const plan = data.individualUsage?.plan ?? {}
  const resetAt = data.billingCycleEnd
  const values: Array<[string, unknown]> = [
    ['Included total', plan.totalPercentUsed],
    ['API models', plan.apiPercentUsed],
    ['Auto model', plan.autoPercentUsed],
  ]
  const windows: UsageWindow[] = values.flatMap(([label, value]) =>
    typeof value === 'number'
      ? [{ label, usedPercent: Math.max(0, Math.min(100, value)), resetAt, kind: 'weeklyScoped' as const }]
      : [],
  )
  return { providerId: 'cursor', windows, lastUpdated: new Date().toISOString(), accountLabel, experimental: true }
}

export async function fetchCodexUsage(): Promise<ProviderUsageSnapshot> {
  return cachedUsage('codex', async () => {
    const credentials = await getValidCodexCredentials()
    if (!credentials) throw new Error('Codex is not connected')
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: {
        authorization: `Bearer ${credentials.access}`,
        'chatgpt-account-id': credentials.accountId,
        'user-agent': 'codex-cli',
      },
    })
    if (!response.ok) throw new Error(`Codex usage request failed (${response.status})`)
    const data = await response.json() as JSONMap
    return normalizeCodexUsage(data, data.email ?? credentials.accountId)
  })
}

export async function fetchAnthropicUsage(): Promise<ProviderUsageSnapshot> {
  return cachedUsage('anthropic', async () => {
    const token = await getAccessToken()
    if (!token) throw new Error('Anthropic is not connected')
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    })
    if (!response.ok) throw new Error(`Anthropic usage request failed (${response.status})`)
    return normalizeAnthropicUsage(await response.json() as JSONMap)
  })
}

export async function fetchCursorUsage(): Promise<ProviderUsageSnapshot> {
  return cachedUsage('cursor', async () => {
  const token = await getCursorSessionToken()
  if (!token) throw new Error('Cursor is not connected')
  const cookie = `WorkosCursorSessionToken=${token}`
  const headers = { cookie, origin: 'https://cursor.com' }
  const profile = await fetch('https://cursor.com/api/auth/me', { headers })
  if (!profile.ok) throw new Error(`Cursor profile request failed (${profile.status})`)
  const account = await profile.json() as JSONMap
  if (!account.sub) throw new Error('Cursor profile did not return a user ID')

  const bootstrap = await fetch(
    'https://cursor.com/api/auth/bootstrap-cursor-web-target?redirectTo=%2Fdashboard%2Fusage',
    { headers, redirect: 'manual' },
  )
  const getSetCookie = (bootstrap.headers as Headers & {
    getSetCookie?: () => string[]
    getAll?: (name: string) => string[]
  }).getSetCookie
  const setCookies = getSetCookie
    ? getSetCookie.call(bootstrap.headers)
    : (bootstrap.headers as Headers & { getAll?: (name: string) => string[] }).getAll?.('set-cookie') ?? []
  const dashboardCookie = [cookie, ...setCookies.map(value => value.split(';', 1)[0])].join('; ')
  const summary = await fetch('https://cursor.com/api/usage-summary', {
    headers: { ...headers, cookie: dashboardCookie },
  })
  if (summary.ok) {
    const snapshot = normalizeCursorUsage(await summary.json() as JSONMap, account.email)
    if (snapshot.windows.length) return snapshot
  }

  const response = await fetch(`https://cursor.com/api/usage?user=${encodeURIComponent(account.sub)}`, { headers })
  if (!response.ok) throw new Error(`Cursor usage request failed (${response.status})`)
  const data = await response.json() as JSONMap
  const usage = data['gpt-4'] ?? data
  const used = Number(usage.numRequests ?? usage.used ?? 0)
  const limit = Number(usage.maxRequestUsage ?? usage.limit ?? 0)
  const windows: UsageWindow[] = limit > 0 ? [{
    label: 'Monthly',
    usedPercent: Math.max(0, Math.min(100, used / limit * 100)),
    resetAt: data.startOfMonth,
    kind: 'weeklyScoped',
  }] : []
  return {
    providerId: 'cursor',
    windows,
    lastUpdated: new Date().toISOString(),
    accountLabel: account.email,
    experimental: true,
  }
  })
}
