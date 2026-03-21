import { SetMetadata } from '@nestjs/common';
import { PluginHookName } from '../enums/hook-events.enum';

export const HOOK_HANDLER_METADATA = 'HOOK_HANDLER_METADATA';

/**
 * Decorator để đăng ký method làm plugin hook handler.
 *
 * @example
 * ```ts
 * @Injectable()
 * export class MyPlugin {
 *   @OnHook(PluginHookName.BEFORE_AGENT_START, { priority: 10 })
 *   async onBeforeAgentStart(context: IAgentHookContext) {
 *     context.model = 'gpt-4o';
 *     return context;
 *   }
 *
 *   @OnHook(PluginHookName.MESSAGE_RECEIVED)
 *   async onMessageReceived(context: IMessageHookContext) {
 *     // logging, filtering, etc.
 *   }
 * }
 * ```
 */
export function OnHook(
  hookName: PluginHookName,
  options?: { priority?: number },
): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    const existing =
      Reflect.getMetadata(HOOK_HANDLER_METADATA, target.constructor) || [];

    existing.push({
      hookName,
      priority: options?.priority ?? 0,
      methodName: String(propertyKey),
    });

    Reflect.defineMetadata(HOOK_HANDLER_METADATA, existing, target.constructor);

    return descriptor;
  };
}
