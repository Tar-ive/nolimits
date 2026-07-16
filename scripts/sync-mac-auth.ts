import { execFileSync } from 'node:child_process'
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getAccessToken } from '../src/auth/oauth-manager'
import { parseCodexAuthJSON, setCodexCredentials } from '../src/auth/codex-auth'
import { setCursorToken } from '../src/gateway/cursor-auth'
import { setAntigravityCredentials, setOpenCodeSession } from '../src/auth/provider-auth'

function cursorSessionToken(): string {
  const db = join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb')
  let token = execFileSync('sqlite3', [db, "select value from ItemTable where key='cursorAuth/accessToken';"], { encoding: 'utf8' }).trim()
  try { token = JSON.parse(token) } catch {}
  if (!token) throw new Error('Cursor access token was not found')
  if (token.includes('::')) return token
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
  if (!payload.sub) throw new Error('Cursor token has no subject claim')
  return `${payload.sub}::${token}`
}

function decryptChromiumCookie(hex: string, host: string, password: string) {
  const encrypted = Buffer.from(hex, 'hex').subarray(3)
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  let value = Buffer.concat([decipher.update(encrypted), decipher.final()])
  const hostHash = createHash('sha256').update(host).digest()
  if (value.subarray(0, 32).equals(hostHash)) value = value.subarray(32)
  return value.toString('utf8')
}

async function openCodeSession() {
  const roots = [
    { path: join(homedir(), 'Library/Application Support/Google/Chrome'), account: 'Chrome', service: 'Chrome Safe Storage' },
    { path: join(homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser'), account: 'Brave', service: 'Brave Safe Storage' },
  ]
  for (const root of roots) {
    if (!existsSync(root.path)) continue
    let password: string
    try { password = execFileSync('security', ['find-generic-password', '-a', root.account, '-s', root.service, '-w'], { encoding: 'utf8' }).trim() }
    catch { continue }
    const profiles = readdirSync(root.path).filter(name => name === 'Default' || name.startsWith('Profile '))
    for (const profile of profiles) {
      const db = join(root.path, profile, 'Cookies')
      if (!existsSync(db)) continue
      const row = execFileSync('sqlite3', ['-separator', '|', db,
        "select host_key,hex(encrypted_value) from cookies where host_key in ('opencode.ai','.opencode.ai') and name='auth' order by expires_utc desc limit 1;"],
      { encoding: 'utf8' }).trim()
      if (!row) continue
      const separator = row.indexOf('|')
      const host = row.slice(0, separator)
      try {
        const cookie = decryptChromiumCookie(row.slice(separator + 1), host, password)
        const auth = await fetch('https://opencode.ai/auth', { headers: { cookie: `auth=${cookie}` }, redirect: 'manual' })
        const workspaceId = auth.headers.get('location')?.match(/\/workspace\/(wrk_[^/]+)/)?.[1]
        if (workspaceId) return { cookie, workspaceId }
      } catch {}
    }
  }
  throw new Error('A signed-in OpenCode browser session was not found')
}

async function main() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Upstash Redis environment variables are required')
  }
  const codex = JSON.parse(readFileSync(join(homedir(), '.codex/auth.json'), 'utf8'))
  await setCodexCredentials(parseCodexAuthJSON(codex))
  console.log('Codex: synced to auth:codex')

  const cursor = cursorSessionToken()
  const check = await fetch('https://cursor.com/api/auth/me', {
    headers: { cookie: `WorkosCursorSessionToken=${cursor}`, origin: 'https://cursor.com' },
  })
  if (!check.ok) throw new Error(`Cursor authentication failed (${check.status})`)
  await setCursorToken(cursor)
  console.log('Cursor: synced to auth:cursor')

  const google = JSON.parse(readFileSync(join(homedir(), '.gemini/oauth_creds.json'), 'utf8'))
  if (!google.refresh_token) throw new Error('Gemini/Antigravity refresh token was not found')
  await setAntigravityCredentials({
    accessToken: google.access_token, refreshToken: google.refresh_token,
    expiryDate: google.expiry_date, idToken: google.id_token,
    scope: google.scope, tokenType: google.token_type,
  })
  console.log('Antigravity: synced to auth:antigravity')

  await setOpenCodeSession(await openCodeSession())
  console.log('OpenCode Go: synced browser session to auth:opencode')

  console.log(`Claude: ${await getAccessToken() ? 'present in auth:anthropic' : 'not connected'}`)
}

main().catch((error) => { console.error(error.message); process.exit(1) })
