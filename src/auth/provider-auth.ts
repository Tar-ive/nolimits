import { Redis } from '@upstash/redis'

export interface AntigravityCredentials {
  accessToken: string
  refreshToken: string
  expiryDate: number
  idToken?: string
  scope?: string
  tokenType?: string
}

export interface OpenCodeSession {
  cookie: string
  workspaceId: string
}

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null

function requireRedis() {
  if (!redis) throw new Error('Upstash Redis is not configured')
  return redis
}

export const getAntigravityCredentials = () => redis?.get<AntigravityCredentials>('auth:antigravity') ?? null
export const setAntigravityCredentials = (value: AntigravityCredentials) => requireRedis().set('auth:antigravity', value)
export const getOpenCodeSession = () => redis?.get<OpenCodeSession>('auth:opencode') ?? null
export const setOpenCodeSession = (value: OpenCodeSession) => requireRedis().set('auth:opencode', value)
