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

  private activeBots = new Map<string, string>();

  async initialize(config: Record<string, unknown>): Promise<void> {
    this.logger.log(
      `Discord channel initialized (${this.activeBots.size} bots active)`,
    );
  }

  async shutdown(): Promise<void> {
    this.activeBots.clear();
    this.logger.log('Discord channel shutdown');
  }

  registerBot(botToken: string, ownerIdentifier: string): void {
    this.activeBots.set(botToken, ownerIdentifier);
  }

  async sendMessage(message: IOutboundMessage): Promise<void> {
    this.logger.debug(
      `Outbound Discord → ${message.targetId}: ${message.content.slice(0, 50)}...`,
    );
  }

  isConfigured(): boolean {
    return this.activeBots.size > 0;
  }
}
