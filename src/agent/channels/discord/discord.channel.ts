import { Injectable, Logger } from '@nestjs/common';
import {
  IChannelAdapter,
  IChannelCapabilities,
  IChannelMeta,
  IOutboundMessage,
} from '../interfaces/channel.interface';

@Injectable()
export class DiscordChannel implements IChannelAdapter {
  private readonly logger = new Logger(DiscordChannel.name);

  readonly meta: IChannelMeta = {
    id: 'discord',
    name: 'Discord',
    description: 'Discord Bot channel adapter',
  };

  readonly capabilities: IChannelCapabilities = {
    supportsMedia: true,
    supportsGroups: true,
    supportsThreads: true,
    supportsReactions: true,
    supportsStreaming: false,
    supportsVoice: true,
    maxMessageLength: 2000,
  };

  private botToken: string | null = null;

  async initialize(config: Record<string, unknown>): Promise<void> {
    this.logger.log('Discord channel initialized');
  }

  async shutdown(): Promise<void> {
    this.logger.log('Discord channel shutdown');
  }

  async sendMessage(message: IOutboundMessage): Promise<void> {
    this.logger.debug(`Sending message to ${message.targetId}`);
  }

  isConfigured(): boolean {
    return !!this.botToken;
  }
}
