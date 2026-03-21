import { IInboundMessage } from '../../channels/interfaces/channel.interface';
import { ILlmMessage } from '../../providers/interfaces/llm-provider.interface';
import { ModelTier, IntentType } from '../model-router/model-tier.enum';

export enum PipelineStage {
  RECEIVED = 'received',
  PREPROCESSED = 'preprocessed',
  ROUTED = 'routed',
  AGENT_RUNNING = 'agent_running',
  AGENT_COMPLETED = 'agent_completed',
  DELIVERED = 'delivered',
  FAILED = 'failed',
}

export interface IModelRouting {
  intent: IntentType;
  tier: ModelTier;
  model: string;
  reason: string;
  fallback: boolean;
}

export interface IPipelineContext {
  runId: string;
  stage: PipelineStage;

  userId: number;
  threadId: string;
  actorTelegramId?: string;

  inboundMessage: IInboundMessage;
  sourceChannelId: string;
  processedContent: string;

  mediaPath?: string;
  mediaPaths?: string[];
  mediaUrl?: string;
  transcript?: string;

  conversationHistory: ILlmMessage[];
  model?: string;
  activeSkills?: string[];

  routing?: IModelRouting;

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
