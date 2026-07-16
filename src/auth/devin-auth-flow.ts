interface DevinTokenResponse {
  access_token: string
  expires_in?: number
}

/**
 * Generate instructions for manual Devin authentication
 */
export function getDevinAuthInstructions(): string {
  return `
🔐 Devin CLI Authentication Required

To authenticate with Devin CLI, follow these steps:

1. Open your terminal and run:
   devin auth login --force-manual-token-flow

2. Follow the prompts to authenticate via your browser

3. Copy the authentication token that is displayed

4. Paste the token below and press Enter

The token will be stored securely and used to authenticate your requests.
`
}

/**
 * Read token from stdin
 */
async function readTokenFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    let token = ''
    process.stdin.setEncoding('utf8')
    process.stdin.resume()

    process.stdin.on('data', (chunk) => {
      token += chunk
      if (token.includes('\n')) {
        process.stdin.pause()
        resolve(token.trim())
      }
    })
  })
}

/**
 * Start manual Devin authentication flow (CLI version)
 */
export async function startDevinAuthFlow(): Promise<string> {
  console.log(getDevinAuthInstructions())

  // Read token from stdin
  const token = await readTokenFromStdin()

  if (!token) {
    throw new Error('No token provided')
  }

  return token
}

/**
 * Validate and process Devin token
 * This is a simple validation - in production you might want to verify
 * the token with Devin's API
 */
export async function validateDevinToken(token: string): Promise<boolean> {
  // Basic validation - check if token looks reasonable
  // Devin tokens are typically JWT-like or long random strings
  if (!token || token.length < 20) {
    return false
  }

  // In production, you would validate this with Devin's API
  // For now, we'll do basic format validation
  return true
}

/**
 * Generate auth session for web UI
 */
export async function generateDevinAuthSession(): Promise<{
  instructions: string
  sessionId: string
}> {
  const sessionId = generateSessionId()
  const instructions = getDevinAuthInstructions()

  return { instructions, sessionId }
}

/**
 * Handle manual token submission from web UI
 */
export async function handleDevinTokenSubmit(
  token: string,
  sessionId: string,
): Promise<DevinTokenResponse> {
  // Validate the token
  const isValid = await validateDevinToken(token)
  if (!isValid) {
    throw new Error('Invalid Devin token')
  }

  const { setDevinToken } = await import('./devin-token-store')
  await setDevinToken(token)

  // Return token response (similar format to OAuth)
  return {
    access_token: token,
    expires_in: 31536000, // 1 year default (Devin tokens don't expire by default)
  }
}

/**
 * Generate a random session ID
 */
function generateSessionId(): string {
  return Math.random().toString(36).substring(2, 15) +
         Math.random().toString(36).substring(2, 15)
}

/**
 * Login function (CLI version)
 */
export async function login(): Promise<boolean> {
  try {
    const { getDevinToken, setDevinToken } = await import('./devin-token-store')
    
    // Check if we already have valid credentials
    const existing = await getDevinToken()
    if (existing) {
      console.log('✅ Valid Devin credentials already exist')
      return true
    }

    // Start manual auth flow
    const token = await startDevinAuthFlow()
    
    // Validate token
    const isValid = await validateDevinToken(token)
    if (!isValid) {
      throw new Error('Invalid token format')
    }

    await setDevinToken(token)

    console.log('✅ Devin token saved successfully!')
    return true
  } catch (error) {
    console.error('Devin login failed:', error)
    return false
  }
}

/**
 * Logout function
 */
export async function logout(): Promise<boolean> {
  try {
    const { removeDevinToken } = await import('./devin-token-store')
    await removeDevinToken()
    console.log('✅ Devin credentials removed')
    return true
  } catch (error) {
    console.error('Logout failed:', error)
    return false
  }
}
