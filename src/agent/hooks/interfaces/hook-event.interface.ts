import { InternalHookEvent, PluginHookName } from '../enums/hook-events.enum';

/**
 * Payload cho Internal Hooks (fire-and-forget)
 * Kế thừa từ OpenClaw InternalHookEvent
 */
export interface IHookEventPayload {
  type: string;
  action: string;
  sessionKey: string;
  userId?: number;
  context: Record<string, unknown>;
  timestamp: Date;
  messages: string[];
}

/**
 * Context cho message-related hooks
 */
export interface IMessageHookContext {
  channelId: string;
  senderId: string;
  threadId: string;
  content: string;
  mediaPath?: string;
  mediaUrl?: string;
  transcript?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Context cho agent pipeline hooks
 */
export interface IAgentHookContext {
  sessionKey: string;
  userId: number;
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  tools?: string[];
  tokensUsed?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Context cho tool/skill hooks
 */
export interface IToolHookContext {
  skillCode: string;
  parameters: Record<string, unknown>;
  result?: unknown;
  error?: Error;
  durationMs?: number;
}

/**
 * Context cho session hooks
 */
export interface ISessionHookContext {
  threadId: string;
  userId: number;
  isActive: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Plugin hook registration (có priority)
 */
export interface IPluginHookRegistration<T = unknown> {
  hookName: PluginHookName;
  handler: (context: T) => Promise<T | void>;
  priority: number;
}

/**
 * Kết quả trả về từ modifying hook
 */
export interface IHookResult<T = unknown> {
  modified: boolean;
  data: T;
}
