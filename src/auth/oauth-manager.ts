import { Redis } from '@upstash/redis'

interface OAuthCredentials {
  type: 'oauth'
  refresh: string
  access: string
  expires: number
}

interface AuthData {
  [provider: string]: OAuthCredentials
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

// Initialize Redis client lazily only if environment variables are present
let redis: Redis | null = null

function getRedis(): Redis | null {
  if (redis === null && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    } catch (error) {
      console.error('Failed to initialize Redis:', error)
      redis = null
    }
  }
  return redis
}

// Redis key for auth data
const AUTH_KEY = 'auth:anthropic'

async function get(): Promise<OAuthCredentials | null> {
  const client = getRedis()
  if (!client) return null
  try {
    const data = await client.get<OAuthCredentials>(AUTH_KEY)
    return data
  } catch (error) {
    console.error('Error getting auth from Redis:', error)
    return null
  }
}

async function set(credentials: OAuthCredentials): Promise<boolean> {
  const client = getRedis()
  if (!client) {
    console.warn('Redis not configured, skipping auth storage')
    return false
  }
  try {
    await client.set(AUTH_KEY, credentials)
    return true
  } catch (error) {
    console.error('Error saving auth to Redis:', error)
    throw error
  }
}

async function remove(): Promise<boolean> {
  const client = getRedis()
  if (!client) {
    console.warn('Redis not configured, skipping auth removal')
    return false
  }
  try {
    await client.del(AUTH_KEY)
    return true
  } catch (error) {
    console.error('Error removing auth from Redis:', error)
    throw error
  }
}

async function getAll(): Promise<AuthData> {
  const client = getRedis()
  if (!client) return {}
  try {
    const credentials = await client.get<OAuthCredentials>(AUTH_KEY)
    if (credentials) {
      return { anthropic: credentials }
    }
    return {}
  } catch (error) {
    console.error('Error getting all auth from Redis:', error)
    return {}
  }
}

async function refreshToken(
  credentials: OAuthCredentials,
): Promise<string | null> {
  try {
    const CLIENT_ID = process.env.ANTHROPIC_OAUTH_CLIENT_ID
    if (!CLIENT_ID) {
      console.warn('ANTHROPIC_OAUTH_CLIENT_ID not set - cannot refresh token')
      return null
    }

    const response = await fetch(
      'https://console.anthropic.com/v1/oauth/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: credentials.refresh,
          client_id: CLIENT_ID,
        }),
      },
    )

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to refresh token: ${error}`)
    }

    const data = (await response.json()) as TokenResponse

    const newCredentials: OAuthCredentials = {
      type: 'oauth',
      refresh: data.refresh_token,
      access: data.access_token,
      expires: Date.now() + data.expires_in * 1000,
    }

    await set(newCredentials)

    return data.access_token
  } catch (error) {
    console.error('Error refreshing token:', error)
    return null
  }
}

async function getAccessToken(): Promise<string | null> {
  const credentials = await get()
  if (!credentials || credentials.type !== 'oauth') {
    return null
  }

  // Check if token is expired
  if (credentials.expires && credentials.expires > Date.now()) {
    console.log('Token is valid')
    return credentials.access
  }

  // Token is expired, need to refresh
  if (credentials.refresh) {
    console.log('Token is expired, need to refresh')
    return await refreshToken(credentials)
  }

  return null
}

export { get, set, remove, getAll, getAccessToken }
