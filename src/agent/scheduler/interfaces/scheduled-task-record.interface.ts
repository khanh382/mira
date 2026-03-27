import {
  ScheduledTargetType,
  TaskSource,
  TaskStatus,
} from '../entities/scheduled-task.entity';

export interface IScheduledTaskRecord {
  id: number;
  userId: number;
  code: string;
  name: string;
  description: string | null;
  cronExpression: string;
  targetType: ScheduledTargetType;
  agentPrompt: string | null;
  n8nWorkflowKey: string | null;
  n8nPayload: Record<string, unknown> | null;
  notifyChannelId: string | null;
  notifyTargetId: string | null;
  allowedSkills: string[] | null;
  source: TaskSource;
  status: TaskStatus;
  maxRetries: number;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  autoPauseOnMaxRetries: boolean;
  maxTokensPerRun: number;
  maxModelTier: string | null;
  timeoutMs: number;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
