import { Injectable, Logger } from '@nestjs/common';
import {
  IChannelAdapter,
  IInboundMessage,
} from './interfaces/channel.interface';

/**
 * ChannelsService quản lý registry các channel adapters.
 * Kế thừa pattern listChannelPlugins / getChannelPlugin từ OpenClaw.
 */
@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);
  private readonly channels = new Map<string, IChannelAdapter>();

  registerChannel(adapter: IChannelAdapter): void {
    this.channels.set(adapter.meta.id, adapter);
    this.logger.log(
      `Channel registered: ${adapter.meta.name} (${adapter.meta.id})`,
    );
  }

  getChannel(channelId: string): IChannelAdapter | undefined {
    return this.channels.get(channelId);
  }

  listChannels(): IChannelAdapter[] {
    return Array.from(this.channels.values());
  }

  listConfiguredChannels(): IChannelAdapter[] {
    return this.listChannels().filter((ch) => ch.isConfigured());
  }

  async initializeAll(): Promise<void> {
    for (const [id, channel] of this.channels) {
      if (!channel.isConfigured()) {
        this.logger.warn(`Channel ${id} not configured, skipping`);
        continue;
      }
      try {
        await channel.initialize({});
        this.logger.log(`Channel ${id} initialized`);
      } catch (error) {
        this.logger.error(
          `Failed to initialize channel ${id}: ${error.message}`,
        );
      }
    }
  }

  async shutdownAll(): Promise<void> {
    for (const [id, channel] of this.channels) {
      try {
        await channel.shutdown();
      } catch (error) {
        this.logger.error(`Failed to shutdown channel ${id}: ${error.message}`);
      }
    }
  }
}
