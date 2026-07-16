import type { ProviderKind } from '../config'
import type { ProviderHandler } from './types'
import { anthropicHandler } from './anthropic'
import { openaiCompatibleHandler } from './openai-compatible'
import { cursorHandler } from './cursor'
import { devinHandler } from './devin'

const handlers: Record<ProviderKind, ProviderHandler> = {
  'anthropic-oauth': anthropicHandler,
  'openai-compatible': openaiCompatibleHandler,
  cursor: cursorHandler,
  'devin-oauth': devinHandler,
}

export function handlerFor(kind: ProviderKind): ProviderHandler {
  return handlers[kind]
}

export type { ProviderHandler, UpstreamResponse } from './types'
