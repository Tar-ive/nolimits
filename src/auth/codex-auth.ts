import { Redis } from '@upstash/redis'

export interface CodexCredentials {
  type: 'oauth'
  access: string
  refresh?: string
  idToken?: string
  accountId: string
  expires?: number
  lastRefresh: number
}

type AuthJSON = {
  access_token?: string
  refresh_token?: string
  id_token?: string
  account_id?: string
  tokens?: AuthJSON
}

const KEY = 'auth:codex'
let redis: Redis | null | undefined

function client(): Redis | null {
  if (redis !== undefined) return redis
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  redis = url && token ? new Redis({ url, token }) : null
  return redis
}

function jwtExpiry(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

export function parseCodexAuthJSON(body: AuthJSON): CodexCredentials {
  const source = body.tokens ?? body
  const access = source.access_token?.trim()
  const accountId = source.account_id?.trim()
  if (!access || !accountId) throw new Error('access_token and account_id are required')
  return {
    type: 'oauth',
    access,
    refresh: source.refresh_token?.trim() || undefined,
    idToken: source.id_token?.trim() || undefined,
    accountId,
    expires: jwtExpiry(access),
    lastRefresh: Date.now(),
  }
}

export async function getCodexCredentials(): Promise<CodexCredentials | null> {
  return (await client()?.get<CodexCredentials>(KEY)) ?? null
}

export async function setCodexCredentials(value: CodexCredentials): Promise<void> {
  const redis = client()
  if (!redis) throw new Error('Redis is not configured')
  await redis.set(KEY, value)
}

export async function removeCodexCredentials(): Promise<void> {
  await client()?.del(KEY)
}

async function refresh(value: CodexCredentials): Promise<CodexCredentials | null> {
  const clientId = process.env.OPENAI_OAUTH_CLIENT_ID
  if (!clientId || !value.refresh) return null
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: value.refresh,
    client_id: clientId,
  })
  const response = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!response.ok) throw new Error(`Codex token refresh failed (${response.status})`)
  const data = await response.json() as AuthJSON & { expires_in?: number }
  const next: CodexCredentials = {
    ...value,
    access: data.access_token ?? value.access,
    refresh: data.refresh_token ?? value.refresh,
    idToken: data.id_token ?? value.idToken,
    expires: data.expires_in ? Date.now() + data.expires_in * 1000 : jwtExpiry(data.access_token ?? value.access),
    lastRefresh: Date.now(),
  }
  await setCodexCredentials(next)
  return next
}

export async function getValidCodexCredentials(): Promise<CodexCredentials | null> {
  const value = await getCodexCredentials()
  if (!value) return null
  if (!value.expires || value.expires > Date.now() + 60_000) return value
  return refresh(value)
}
