import { CronJobTargetType } from '../entities/cron-job.entity';

export interface CreateCronJobDto {
  name: string;
  cronExpression: string;
  targetType: CronJobTargetType;
  targetId: number;
  enabled?: boolean;
  maxConsecutiveFailures?: number;
}

export interface UpdateCronJobDto {
  name?: string;
  cronExpression?: string;
  enabled?: boolean;
  maxConsecutiveFailures?: number;
}
