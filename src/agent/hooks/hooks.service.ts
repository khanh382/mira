import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { InternalHookEvent, PluginHookName } from './enums/hook-events.enum';
import {
  IHookEventPayload,
  IPluginHookRegistration,
} from './interfaces/hook-event.interface';
import { PluginHookHandler } from './interfaces/hook-handler.interface';
import { HOOK_HANDLER_METADATA } from './decorators/on-hook.decorator';

/**
 * HooksService quản lý 2 hệ thống hook kế thừa từ OpenClaw:
 *
 * 1. Internal Hooks — dùng EventEmitter2, fire-and-forget, chạy song song
 *    → Phù hợp cho logging, analytics, side-effects
 *
 * 2. Plugin Hooks — registry riêng, có priority, chạy tuần tự
 *    → Phù hợp cho modify data trước khi xử lý (intercept pattern)
 */
@Injectable()
export class HooksService implements OnModuleInit {
  private readonly logger = new Logger(HooksService.name);

  private readonly pluginHooks = new Map<
    PluginHookName,
    Array<{ handler: PluginHookHandler; priority: number }>
  >();

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
  ) {}

  onModuleInit() {
    this.discoverHookHandlers();
  }

  // ─── Internal Hooks (EventEmitter) ──────────────────────────────────

  async emitInternal(
    event: InternalHookEvent,
    payload: Partial<IHookEventPayload>,
  ): Promise<void> {
    const fullPayload: IHookEventPayload = {
      type: event.split('.')[0],
      action: event.split('.').slice(1).join('.'),
      sessionKey: '',
      context: {},
      timestamp: new Date(),
      messages: [],
      ...payload,
    };

    this.logger.debug(`Emitting internal hook: ${event}`);
    this.eventEmitter.emit(event, fullPayload);
  }

  onInternal(
    event: InternalHookEvent,
    handler: (payload: IHookEventPayload) => Promise<void>,
  ): void {
    this.eventEmitter.on(event, handler);
  }

  // ─── Plugin Hooks (Priority-ordered, sequential) ────────────────────

  registerPluginHook<T>(
    hookName: PluginHookName,
    handler: PluginHookHandler<T>,
    priority = 0,
  ): void {
    if (!this.pluginHooks.has(hookName)) {
      this.pluginHooks.set(hookName, []);
    }
    this.pluginHooks.get(hookName).push({
      handler: handler as PluginHookHandler,
      priority,
    });
    this.pluginHooks
      .get(hookName)
      .sort((a, b) => b.priority - a.priority);

    this.logger.debug(
      `Registered plugin hook: ${hookName} (priority: ${priority})`,
    );
  }

  /**
   * Chạy tất cả plugin hooks cho một hookName theo thứ tự priority (cao → thấp).
   * Mỗi handler nhận context từ handler trước → có thể modify rồi trả lại.
   */
  async executePluginHook<T>(hookName: PluginHookName, context: T): Promise<T> {
    const handlers = this.pluginHooks.get(hookName);
    if (!handlers?.length) return context;

    let current = context;
    for (const { handler } of handlers) {
      try {
        const result = await handler(current);
        if (result !== undefined && result !== null) {
          current = result as T;
        }
      } catch (error) {
        this.logger.error(
          `Plugin hook "${hookName}" handler failed: ${error.message}`,
          error.stack,
        );
      }
    }

    return current;
  }

  /**
   * Chạy plugin hooks nhưng không quan tâm return value (void hooks)
   * → chạy song song, fire-and-forget
   */
  async executeVoidPluginHook<T>(
    hookName: PluginHookName,
    context: T,
  ): Promise<void> {
    const handlers = this.pluginHooks.get(hookName);
    if (!handlers?.length) return;

    await Promise.allSettled(
      handlers.map(({ handler }) =>
        handler(context).catch((err) =>
          this.logger.error(
            `Void plugin hook "${hookName}" failed: ${err.message}`,
          ),
        ),
      ),
    );
  }

  // ─── Auto-discovery: scan @OnHook() decorators ─────────────────────

  private discoverHookHandlers(): void {
    const providers = this.discoveryService.getProviders();

    for (const wrapper of providers) {
      const { instance } = wrapper;
      if (!instance || !instance.constructor) continue;

      const hookMeta: Array<{
        hookName: PluginHookName;
        priority: number;
        methodName: string;
      }> = Reflect.getMetadata(HOOK_HANDLER_METADATA, instance.constructor);

      if (!hookMeta?.length) continue;

      for (const { hookName, priority, methodName } of hookMeta) {
        const handler = instance[methodName].bind(instance);
        this.registerPluginHook(hookName, handler, priority);
        this.logger.log(
          `Discovered @OnHook(${hookName}) on ${instance.constructor.name}.${methodName}`,
        );
      }
    }
  }
}
