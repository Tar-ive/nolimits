/**
 * Windsurf Session Management for Devin CLI
 * 
 * Handles session token generation, validation, and management
 * using the Windsurf protocol format
 */

import { createHash, randomBytes } from 'crypto';

export interface WindsurfSession {
  sessionId: string;
  jwt: string;
  apiKey: string;
  apiServerUrl: string;
  expiresAt: number;
  createdAt: number;
}

export class SessionManager {
  private sessions: Map<string, WindsurfSession> = new Map();
  private apiKey: string;
  private apiServerUrl: string;

  constructor(apiKey: string, apiServerUrl: string) {
    this.apiKey = apiKey;
    this.apiServerUrl = apiServerUrl;
  }

  /**
   * Generate a Windsurf-compatible session token
   * Format: devin-session-token$<jwt_payload>
   */
  generateSessionToken(): string {
    const sessionId = randomBytes(16).toString('hex');
    
    // Create a simple JWT-like payload
    const header = {
      alg: 'HS256',
      typ: 'JWT'
    };
    
    const payload = {
      session_id: `windsurf-session-${sessionId}`,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400, // 24 hours
      api_key: this.apiKey.substring(0, 32) + '...' // Partial key for validation
    };
    
    // Base64 encode without padding
    const base64UrlEncode = (obj: any) => {
      return Buffer.from(JSON.stringify(obj))
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    };
    
    const encodedHeader = base64UrlEncode(header);
    const encodedPayload = base64UrlEncode(payload);
    
    // Create signature (simplified - in production use proper HMAC)
    const signature = createHash('sha256')
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    
    const token = `${encodedHeader}.${encodedPayload}.${signature}`;
    
    return `devin-session-token$${token}`;
  }

  /**
   * Validate a Windsurf session token format
   */
  validateTokenFormat(token: string): boolean {
    if (!token.startsWith('devin-session-token$')) {
      return false;
    }
    
    const jwtPart = token.split('$')[1];
    const parts = jwtPart.split('.');
    
    if (parts.length !== 3) {
      return false;
    }
    
    try {
      // Basic structure validation
      const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      
      return !!(header.alg && header.typ && payload.session_id);
    } catch {
      return false;
    }
  }

  /**
   * Extract session ID from Windsurf token
   */
  extractSessionId(token: string): string | null {
    if (!this.validateTokenFormat(token)) {
      return null;
    }
    
    try {
      const jwtPart = token.split('$')[1];
      const payload = JSON.parse(Buffer.from(jwtPart.split('.')[1], 'base64').toString());
      return payload.session_id;
    } catch {
      return null;
    }
  }

  /**
   * Create or get existing session (accepts any token for now)
   */
  createOrUpdateSession(token: string): WindsurfSession {
    // Generate a session ID if the token is not in Windsurf format
    let sessionId: string;
    
    if (this.validateTokenFormat(token)) {
      sessionId = this.extractSessionId(token)!;
    } else {
      sessionId = randomBytes(16).toString('hex');
    }

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        jwt: token,
        apiKey: this.apiKey,
        apiServerUrl: this.apiServerUrl,
        expiresAt: Date.now() + 86400000, // 24 hours
        createdAt: Date.now(),
      };
      this.sessions.set(sessionId, session);
    }

    return session;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): WindsurfSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    
    // Check if expired
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(sessionId);
      return null;
    }
    
    return session;
  }

  /**
   * Clean up expired sessions
   */
  cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (session.expiresAt < now) {
        this.sessions.delete(id);
      }
    }
  }
}

// Global session manager instance
let globalSessionManager: SessionManager | null = null;

export function getGlobalSessionManager(): SessionManager {
  if (!globalSessionManager) {
    // In production, these would come from environment variables
    const apiKey = process.env.WINDSURF_API_KEY || '';
    const apiServerUrl = process.env.WINDSURF_API_SERVER_URL || 'https://server.self-serve.windsurf.com';
    globalSessionManager = new SessionManager(apiKey, apiServerUrl);
  }
  return globalSessionManager;
}