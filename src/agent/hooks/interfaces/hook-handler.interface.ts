import { PluginHookName } from '../enums/hook-events.enum';

/**
 * Internal hook handler — fire-and-forget, chạy song song
 */
export type InternalHookHandler = (
  event: import('./hook-event.interface').IHookEventPayload,
) => Promise<void>;

/**
 * Plugin hook handler — có priority, chạy tuần tự, có thể modify data
 * Return data để chain sang handler tiếp theo, hoặc void nếu không modify
 */
export type PluginHookHandler<T = unknown> = (context: T) => Promise<T | void>;

/**
 * Metadata đăng ký cho decorator @OnHook
 */
export interface HookHandlerMetadata {
  hookName: PluginHookName;
  priority?: number;
  methodName: string;
}

/**
 * Options khi đăng ký hook handler
 */
export interface RegisterHookOptions {
  priority?: number;
  once?: boolean;
}
