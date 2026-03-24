import { StepExecutorType, StepOnFailure } from '../entities/task-step.entity';

export interface TaskStepInputDto {
  stepOrder: number;
  name: string;
  executorType?: StepExecutorType;
  skillCode?: string | null;
  oaId?: number | null;
  prompt: string;
  retryCount?: number;
  timeoutMs?: number;
  onFailure?: StepOnFailure;
}

export interface CreateTaskDto {
  code: string;
  name: string;
  description?: string | null;
  enabled?: boolean;
  steps: TaskStepInputDto[];
}

export interface UpdateTaskDto {
  name?: string;
  description?: string | null;
  enabled?: boolean;
}

export interface ReplaceTaskStepsDto {
  steps: TaskStepInputDto[];
}
