import { Redis } from '@upstash/redis'

// Reactive rate-limit tracking. When a provider returns a limit status we mark
// it in cooldown until its reset time; the dispatcher skips cooling-down
// providers and advances down the failover chain.
//
// In-memory Map is enough for a long-lived local `bun` process. On Vercel each
// invocation is stateless, so when Upstash is configured we mirror cooldowns to
// Redis (reusing the same client shape as src/auth/oauth-manager.ts).

const memory = new Map<string, number>()

const redisEnabled = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
)

const redis = redisEnabled
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  : null

const key = (provider: string) => `cooldown:${provider}`

// HTTP statuses that mean "provider is out of capacity / rate-limited" and
// should trigger cooldown + failover.
export function isLimitStatus(status: number): boolean {
  return (
    status === 429 ||
    status === 529 || // Anthropic "overloaded"
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  )
}

// Cooldown duration (ms) derived from a limit response's headers, with a 60s
// default. Handles Retry-After (seconds or HTTP-date) and the *-ratelimit-reset
// headers Anthropic/OpenAI send (unix seconds or seconds-until-reset).
export function cooldownFromResponse(res: {
  headers: Headers
  status: number
}): number {
  // When a header tells us when to retry, honor it (with a small floor so we
  // don't busy-loop). When there's no usable header, fall back to 60s.
  const DEFAULT_NO_HEADER = 60_000
  const FLOOR = 1_000
  const MAX = 15 * 60_000
  const now = Date.now()

  const retryAfter = res.headers.get('retry-after')
  if (retryAfter) {
    const asNum = Number(retryAfter)
    if (!Number.isNaN(asNum)) return clamp(asNum * 1000, FLOOR, MAX)
    const asDate = Date.parse(retryAfter)
    if (!Number.isNaN(asDate)) return clamp(asDate - now, FLOOR, MAX)
  }

  const reset =
    res.headers.get('anthropic-ratelimit-unified-reset') ||
    res.headers.get('x-ratelimit-reset-requests') ||
    res.headers.get('x-ratelimit-reset-tokens') ||
    res.headers.get('x-ratelimit-reset')
  if (reset) {
    const asNum = Number(reset)
    if (!Number.isNaN(asNum)) {
      // Values > ~1e6 are unix-epoch seconds; smaller values are seconds-from-now.
      const ms = asNum > 1_000_000 ? asNum * 1000 - now : asNum * 1000
      return clamp(ms, FLOOR, MAX)
    }
  }

  return DEFAULT_NO_HEADER
}

function clamp(ms: number, min: number, max: number): number {
  if (Number.isNaN(ms) || ms < min) return min
  return Math.min(ms, max)
}

export async function setCooldown(
  provider: string,
  untilMs: number,
  reason: string,
): Promise<void> {
  memory.set(provider, untilMs)
  const seconds = Math.max(1, Math.ceil((untilMs - Date.now()) / 1000))
  console.log(
    `⏳ [gateway] ${provider} in cooldown for ${seconds}s (${reason})`,
  )
  if (redis) {
    try {
      await redis.set(key(provider), untilMs, { ex: seconds })
    } catch (error) {
      console.error('Error writing cooldown to Redis:', error)
    }
  }
}

export async function isCoolingDown(provider: string): Promise<boolean> {
  const now = Date.now()

  const local = memory.get(provider)
  if (local !== undefined) {
    if (local > now) return true
    memory.delete(provider)
  }

  if (redis) {
    try {
      const until = await redis.get<number>(key(provider))
      if (typeof until === 'number' && until > now) {
        memory.set(provider, until)
        return true
      }
    } catch (error) {
      console.error('Error reading cooldown from Redis:', error)
    }
  }

  return false
}
