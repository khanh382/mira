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

  private activeBots = new Map<string, string>();

  async initialize(config: Record<string, unknown>): Promise<void> {
    this.logger.log(
      `Zalo channel initialized (${this.activeBots.size} bots active)`,
    );
  }

  async shutdown(): Promise<void> {
    this.activeBots.clear();
    this.logger.log('Zalo channel shutdown');
  }

  registerBot(botToken: string, ownerIdentifier: string): void {
    this.activeBots.set(botToken, ownerIdentifier);
  }

  async sendMessage(message: IOutboundMessage): Promise<void> {
    this.logger.debug(
      `Outbound Zalo → ${message.targetId}: ${message.content.slice(0, 50)}...`,
    );
  }

  isConfigured(): boolean {
    return this.activeBots.size > 0;
  }
}
