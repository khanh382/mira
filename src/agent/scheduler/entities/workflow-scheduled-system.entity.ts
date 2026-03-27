import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  ScheduledTargetType,
  TaskSource,
  TaskStatus,
} from './scheduled-task.entity';

@Entity('workflow_scheduled_system')
export class WorkflowScheduledSystem {
  @PrimaryGeneratedColumn({ name: 'task_id' })
  id: number;

  @Column({ name: 'uid' })
  userId: number;

  @Column({ name: 'task_code', unique: true })
  code: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'cron_expression' })
  cronExpression: string;

  @Column({
    name: 'target_type',
    type: 'enum',
    enum: ScheduledTargetType,
    default: ScheduledTargetType.AGENT_PROMPT,
  })
  targetType: ScheduledTargetType;

  @Column({ name: 'agent_prompt', type: 'text', nullable: true })
  agentPrompt: string | null;

  @Column({ name: 'allowed_skills', type: 'json', nullable: true })
  allowedSkills: string[] | null;

  @Column({ type: 'enum', enum: TaskSource, default: TaskSource.AGENT })
  source: TaskSource;

  @Column({ type: 'enum', enum: TaskStatus, default: TaskStatus.ACTIVE })
  status: TaskStatus;

  @Column({ name: 'max_retries', default: 3 })
  maxRetries: number;

  @Column({ name: 'consecutive_failures', default: 0 })
  consecutiveFailures: number;

  @Column({ name: 'total_failures', default: 0 })
  totalFailures: number;

  @Column({ name: 'total_successes', default: 0 })
  totalSuccesses: number;

  @Column({ name: 'auto_pause_on_max_retries', default: true })
  autoPauseOnMaxRetries: boolean;

  @Column({ name: 'max_tokens_per_run', default: 0 })
  maxTokensPerRun: number;

  @Column({ name: 'max_model_tier', nullable: true })
  maxModelTier: string | null;

  @Column({ name: 'timeout_ms', default: 120000 })
  timeoutMs: number;

  @Column({ name: 'last_run_at', nullable: true })
  lastRunAt: Date | null;

  @Column({ name: 'last_success_at', nullable: true })
  lastSuccessAt: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column({ name: 'next_run_at', nullable: true })
  nextRunAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
