/**
 * ACP (Agent Client Protocol) WebSocket Handler for Devin CLI
 * 
 * Implements the Windsurf ACP WebSocket protocol for Devin CLI handoff
 */

import { WebSocketServer, WebSocket } from 'ws';
import { getGlobalSessionManager } from './session-manager';

interface ACPMessage {
  id?: string;
  method?: string;
  params?: any;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

interface ACPContext {
  sessionId: string;
  sessionToken: string;
  initialized: boolean;
  userId?: string;
  orgId?: string;
}

export class ACPWebSocketHandler {
  private wss: WebSocketServer;
  private connections: Map<WebSocket, ACPContext> = new Map();

  constructor(port: number) {
    this.wss = new WebSocketServer({ port })
    this.setupServer()
    console.log(`ACP WebSocket server listening on port ${port}`)
  }

  private setupServer() {
    this.wss.on('connection', (ws: WebSocket, req) => {
      const url = new URL(req.url!, `http://${req.headers.host}`)
      const token = url.searchParams.get('token')
      const path = url.pathname

      console.log(`ACP WebSocket connection attempt on ${path}`, token ? 'with token' : 'without token')

      // Handle different ACP endpoints
      if (path !== '/acp/live' && path !== '/') {
        console.log(`ACP: Unknown path ${path}, closing connection`)
        ws.close(1008, 'Invalid path')
        return
      }

      if (!token) {
        console.log('ACP: No token provided, closing connection')
        ws.close(1008, 'Token required')
        return
      }

      // Validate token format using session manager
      const sessionManager = getGlobalSessionManager()
      if (!sessionManager.validateTokenFormat(token)) {
        console.log('ACP: Invalid token format, closing connection')
        ws.close(1008, 'Invalid token format')
        return
      }

      // Create or get session
      const session = sessionManager.createOrUpdateSession(token)
      
      // Create context for this connection
      const context: ACPContext = {
        sessionId: session.sessionId,
        sessionToken: token,
        initialized: false,
      }

      this.connections.set(ws, context)
      console.log(`ACP: Connection established for session ${context.sessionId}`)

      ws.on('message', async (data: Buffer) => {
        try {
          const message: ACPMessage = JSON.parse(data.toString())
          await this.handleMessage(ws, context, message)
        } catch (error) {
          console.error('Error handling ACP message:', error)
          this.sendError(ws, -32700, 'Parse error')
        }
      })

      ws.on('close', () => {
        console.log(`ACP WebSocket connection closed for session ${context.sessionId}`)
        this.connections.delete(ws)
      })

      ws.on('error', (error) => {
        console.error('ACP WebSocket error:', error)
      })
    })
  }

  private async handleMessage(ws: WebSocket, context: ACPContext, message: ACPMessage) {
    const { id, method, params } = message

    console.log(`ACP RECV: ${method || 'response'}`, id || '')

    if (!method) {
      // This is a response, handle it if needed
      return
    }

    try {
      let result: any

      switch (method) {
        case 'initialize':
          result = await this.handleInitialize(context, params)
          break
        case 'cognition.ai/messageGrouping':
          result = await this.handleMessageGrouping(params)
          break
        case 'cognition.ai/tags':
          result = await this.handleTags(params)
          break
        case 'session/new':
          result = await this.handleSessionNew(context, params)
          break
        case 'session/prompt':
          result = await this.handleSessionPrompt(context, params)
          break
        case 'cognition.ai/snapshot-setup/list-blueprints':
          result = await this.handleListBlueprints(params)
          break
        case 'cognition.ai/snapshot-setup/create-blueprint':
          result = await this.handleCreateBlueprint(params)
          break
        default:
          // For unknown methods, return success to prevent blocking
          console.log(`ACP: Unknown method ${method}, returning success`)
          result = { success: true }
      }

      this.sendResponse(ws, id, result)
    } catch (error) {
      console.error(`Error handling method ${method}:`, error)
      this.sendError(ws, -32601, `Method not found: ${method}`)
    }
  }

  private async handleInitialize(context: ACPContext, params: any): Promise<any> {
    console.log('ACP initialize request')

    context.initialized = true

    // Send initialized notification
    this.sendNotification(null, 'notifications/initialized', {})

    // Return basic capabilities and user info
    return {
      protocolVersion: '1.0.0',
      capabilities: {
        sessionManagement: true,
        handoff: true,
        snapshotSetup: true,
        toolUse: true,
        fileOperations: true,
      },
      user: {
        userId: context.sessionId,
        authenticated: true,
      },
      organizations: [
        {
          id: 'default',
          name: 'Default Organization',
          allowedModels: ['claude-opus-4.8', 'claude-sonnet-4.6', 'claude-haiku-4.5'],
        }
      ]
    }
  }

  private async handleMessageGrouping(params: any): Promise<any> {
    // Placeholder for message grouping logic
    return { grouped: false }
  }

  private async handleTags(params: any): Promise<any> {
    // Placeholder for tags logic
    return { tags: [] }
  }

  private async handleSessionNew(context: ACPContext, params: any): Promise<any> {
    console.log('ACP session/new request')

    const sessionId = context.sessionId
    const session = {
      id: sessionId,
      status: 'active',
      created_at: new Date().toISOString(),
      model: 'claude-3-5-sonnet-20241022',
    }

    return session
  }

  private async handleSessionPrompt(context: ACPContext, params: any): Promise<any> {
    console.log('ACP session/prompt request')

    // This would typically integrate with the inference backend
    // For now, return a mock response
    return {
      response: 'Prompt received and processed',
      session_id: context.sessionId,
      status: 'completed',
    }
  }

  private async handleListBlueprints(params: any): Promise<any> {
    console.log('ACP list-blueprints request')
    return { blueprints: [] }
  }

  private async handleCreateBlueprint(params: any): Promise<any> {
    console.log('ACP create-blueprint request')
    return { success: true, blueprint_id: `blueprint-${Date.now()}` }
  }

  private sendResponse(ws: WebSocket, id: string | undefined, result: any) {
    const message: ACPMessage = {
      id,
      result,
    }
    ws.send(JSON.stringify(message))
    console.log(`ACP SEND: response to ${id || 'unknown'}`)
  }

  private sendError(ws: WebSocket, code: number, message: string) {
    const error: ACPMessage = {
      error: { code, message },
    }
    ws.send(JSON.stringify(error))
    console.log(`ACP SEND: error ${code}: ${message}`)
  }

  private sendNotification(ws: WebSocket | null, method: string, params: any) {
    const message: ACPMessage = {
      method,
      params,
    }
    
    if (ws) {
      ws.send(JSON.stringify(message))
    } else {
      // Broadcast to all connections
      for (const [connection] of this.connections) {
        connection.send(JSON.stringify(message))
      }
    }
    console.log(`ACP SEND: notification ${method}`)
  }

  public close() {
    this.wss.close()
  }
}