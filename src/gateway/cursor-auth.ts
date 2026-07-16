import { Redis } from '@upstash/redis'

// Cursor auth: the WorkosCursorSessionToken cookie has the form
// `user_xxxxx::<JWT>`. Cursor's API wants the JWT part as the bearer token.
//
// Source order: CURSOR_SESSION_TOKEN env first (local), else a Redis-stored
// value set via POST /auth/cursor/token (Vercel). Reuses the same Upstash
// client shape as src/auth/oauth-manager.ts.

const CURSOR_AUTH_KEY = 'auth:cursor'

const redisEnabled = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
)

const redis = redisEnabled
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  : null

// Return the JWT portion (after `::`) of a WorkosCursorSessionToken, or the
// value unchanged if it has no separator (already a bare JWT).
export function extractJwt(sessionToken: string): string {
  const idx = sessionToken.indexOf('::')
  return idx >= 0 ? sessionToken.slice(idx + 2) : sessionToken
}

export async function getCursorSessionToken(): Promise<string | null> {
  const fromEnv = process.env.CURSOR_SESSION_TOKEN
  if (fromEnv) return fromEnv

  if (redis) {
    try {
      const stored = await redis.get<string>(CURSOR_AUTH_KEY)
      if (stored) return stored
    } catch (error) {
      console.error('Error reading Cursor token from Redis:', error)
    }
  }
  return null
}

export async function getCursorToken(): Promise<string | null> {
  const session = await getCursorSessionToken()
  return session ? extractJwt(session) : null
}

export async function setCursorToken(sessionToken: string): Promise<void> {
  if (!redis) {
    throw new Error(
      'Redis not configured; set CURSOR_SESSION_TOKEN in the environment instead.',
    )
  }
  await redis.set(CURSOR_AUTH_KEY, sessionToken)
}

export async function removeCursorToken(): Promise<void> {
  await redis?.del(CURSOR_AUTH_KEY)
}
