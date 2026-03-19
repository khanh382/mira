import { Injectable, Logger } from '@nestjs/common';
import {
  IChannelAdapter,
  IChannelCapabilities,
  IChannelMeta,
  IOutboundMessage,
} from '../interfaces/channel.interface';

@Injectable()
export class SlackChannel implements IChannelAdapter {
  private readonly logger = new Logger(SlackChannel.name);

  readonly meta: IChannelMeta = {
    id: 'slack',
    name: 'Slack',
    description: 'Slack Bot channel adapter',
  };

  readonly capabilities: IChannelCapabilities = {
    supportsMedia: true,
    supportsGroups: true,
    supportsThreads: true,
    supportsReactions: true,
    supportsStreaming: false,
    supportsVoice: false,
    maxMessageLength: 40000,
  };

  private botToken: string | null = null;

  async initialize(config: Record<string, unknown>): Promise<void> {
    this.logger.log('Slack channel initialized');
  }

  async shutdown(): Promise<void> {
    this.logger.log('Slack channel shutdown');
  }

  async sendMessage(message: IOutboundMessage): Promise<void> {
    this.logger.debug(`Sending message to ${message.targetId}`);
  }

  isConfigured(): boolean {
    return !!this.botToken;
  }
}
