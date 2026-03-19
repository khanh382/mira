import { IInboundMessage } from '../../channels/interfaces/channel.interface';
import { ILlmMessage } from '../../providers/interfaces/llm-provider.interface';

export enum PipelineStage {
  RECEIVED = 'received',
  PREPROCESSED = 'preprocessed',
  ROUTED = 'routed',
  AGENT_RUNNING = 'agent_running',
  AGENT_COMPLETED = 'agent_completed',
  DELIVERED = 'delivered',
  FAILED = 'failed',
}

export interface IPipelineContext {
  runId: string;
  stage: PipelineStage;

  userId: number;
  threadId: string;

  inboundMessage: IInboundMessage;
  sourceChannelId: string;
  processedContent: string;

  mediaPath?: string;
  mediaUrl?: string;
  transcript?: string;

  conversationHistory: ILlmMessage[];
  model?: string;
  activeSkills?: string[];

  agentResponse?: string;
  agentToolCalls?: Array<{ skillCode: string; result: unknown }>;
  tokensUsed?: number;

  targetChannelId?: string;
  targetId?: string;

  error?: Error;
  startedAt: Date;
  completedAt?: Date;
  metadata: Record<string, unknown>;
}
