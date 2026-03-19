import { Injectable, Logger } from '@nestjs/common';
import {
  IChannelAdapter,
  IChannelCapabilities,
  IChannelMeta,
  IOutboundMessage,
} from '../interfaces/channel.interface';

@Injectable()
export class ZaloChannel implements IChannelAdapter {
  private readonly logger = new Logger(ZaloChannel.name);

  readonly meta: IChannelMeta = {
    id: 'zalo',
    name: 'Zalo',
    description: 'Zalo OA/Bot channel adapter',
  };

  readonly capabilities: IChannelCapabilities = {
    supportsMedia: true,
    supportsGroups: true,
    supportsThreads: false,
    supportsReactions: true,
    supportsStreaming: false,
    supportsVoice: false,
    maxMessageLength: 2000,
  };

  private botToken: string | null = null;

  async initialize(config: Record<string, unknown>): Promise<void> {
    this.logger.log('Zalo channel initialized');
  }

  async shutdown(): Promise<void> {
    this.logger.log('Zalo channel shutdown');
  }

  async sendMessage(message: IOutboundMessage): Promise<void> {
    this.logger.debug(`Sending message to ${message.targetId}`);
  }

  isConfigured(): boolean {
    return !!this.botToken;
  }
}
