/**
 * Channel abstraction kế thừa từ OpenClaw ChannelPlugin.
 * Mỗi channel (Telegram, Discord, Zalo, Slack, WebChat...)
 * implement interface này để plug vào hệ thống agent.
 */

export interface IChannelMeta {
  id: string;
  name: string;
  description?: string;
  icon?: string;
}

export interface IChannelCapabilities {
  supportsMedia: boolean;
  supportsGroups: boolean;
  supportsThreads: boolean;
  supportsReactions: boolean;
  supportsStreaming: boolean;
  supportsVoice: boolean;
  maxMessageLength?: number;
}

export interface IInboundMessage {
  channelId: string;
  senderId: string;
  senderName?: string;
  content: string;
  groupId?: string;
  threadId?: string;
  mediaPath?: string;
  mediaUrl?: string;
  replyToMessageId?: string;
  raw?: Record<string, unknown>;
  timestamp: Date;
}

export interface IOutboundMessage {
  channelId: string;
  targetId: string;
  content: string;
  groupId?: string;
  threadId?: string;
  mediaUrls?: string[];
  replyToMessageId?: string;
}

export interface IChannelAdapter {
  readonly meta: IChannelMeta;
  readonly capabilities: IChannelCapabilities;

  initialize(config: Record<string, unknown>): Promise<void>;
  shutdown(): Promise<void>;

  sendMessage(message: IOutboundMessage): Promise<void>;

  onMessage?(handler: (message: IInboundMessage) => Promise<void>): void;

  isConfigured(): boolean;
}
