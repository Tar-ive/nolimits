import { Redis } from '@upstash/redis'

const KEY = 'auth:devin'

function client(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  return url && token ? new Redis({ url, token }) : null
}

export async function getDevinToken(): Promise<string | null> {
  return (await client()?.get<string>(KEY)) ?? null
}

export async function setDevinToken(token: string): Promise<void> {
  const redis = client()
  if (!redis) throw new Error('Redis is not configured')
  await redis.set(KEY, token)
}

export async function removeDevinToken(): Promise<void> {
  await client()?.del(KEY)
}
