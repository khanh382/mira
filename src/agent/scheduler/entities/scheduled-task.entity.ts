import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../../modules/users/entities/user.entity';

export enum TaskStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
  DISABLED = 'disabled',
}

export enum TaskSource {
  HEARTBEAT = 'heartbeat',
  AGENT = 'agent',
  MANUAL = 'manual',
}

export enum ScheduledTargetType {
  /** Legacy: run through agent pipeline using agentPrompt. */
  AGENT_PROMPT = 'agent_prompt',
  /** New: dispatch hidden n8n workflow directly (no LLM needed). */
  N8N_WORKFLOW = 'n8n_workflow',
}

@Entity('scheduled_tasks')
export class ScheduledTask {
  @PrimaryGeneratedColumn({ name: 'task_id' })
  id: number;

  @Column({ name: 'uid' })
  userId: number;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'uid' })
  user: User;

  @Column({ name: 'task_code', unique: true })
  code: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ name: 'cron_expression' })
  cronExpression: string;

  @Column({
    name: 'target_type',
    type: 'enum',
    enum: ScheduledTargetType,
    default: ScheduledTargetType.N8N_WORKFLOW,
  })
  targetType: ScheduledTargetType;

  /** Prompt gửi cho agent khi task chạy (legacy path). */
  @Column({ name: 'agent_prompt', type: 'text', nullable: true })
  agentPrompt: string | null;

  /** n8n workflow key to dispatch (required when targetType=n8n_workflow). */
  @Column({ name: 'n8n_workflow_key', type: 'varchar', length: 120, nullable: true })
  n8nWorkflowKey: string | null;

  /** Payload template snapshot (no secrets). */
  @Column({ name: 'n8n_payload', type: 'jsonb', nullable: true })
  n8nPayload: Record<string, unknown> | null;

  /** Notify on completion (optional). */
  @Column({ name: 'notify_channel_id', type: 'varchar', length: 20, nullable: true })
  notifyChannelId: string | null;

  @Column({ name: 'notify_target_id', type: 'varchar', length: 180, nullable: true })
  notifyTargetId: string | null;

  /** Danh sách skill codes được phép dùng (null = tất cả) */
  @Column({ name: 'allowed_skills', type: 'json', nullable: true })
  allowedSkills: string[] | null;

  @Column({ type: 'enum', enum: TaskSource, default: TaskSource.AGENT })
  source: TaskSource;

  @Column({ type: 'enum', enum: TaskStatus, default: TaskStatus.ACTIVE })
  status: TaskStatus;

  // ─── Retry & Budget Policy ────────────────────────────────

  /** Số lần retry tối đa khi lỗi (mặc định 3, giống yêu cầu user) */
  @Column({ name: 'max_retries', default: 3 })
  maxRetries: number;

  /** Số lần fail liên tiếp hiện tại */
  @Column({ name: 'consecutive_failures', default: 0 })
  consecutiveFailures: number;

  /** Tổng số lần fail tích lũy (dùng để quyết định auto-disable) */
  @Column({ name: 'total_failures', default: 0 })
  totalFailures: number;

  /** Tổng số lần chạy thành công */
  @Column({ name: 'total_successes', default: 0 })
  totalSuccesses: number;

  /** Nếu fail liên tiếp >= maxRetries → tự động pause, lần tick tiếp skip.
   *  Reset consecutiveFailures khi success. */
  @Column({ name: 'auto_pause_on_max_retries', default: true })
  autoPauseOnMaxRetries: boolean;

  /** Giới hạn tokens tối đa mỗi lần chạy (0 = không giới hạn) */
  @Column({ name: 'max_tokens_per_run', default: 0 })
  maxTokensPerRun: number;

  /** Model tier tối đa được phép (null = theo Smart Router) */
  @Column({ name: 'max_model_tier', nullable: true })
  maxModelTier: string | null;

  /** Timeout mỗi lần chạy (ms), mặc định 120s */
  @Column({ name: 'timeout_ms', default: 120000 })
  timeoutMs: number;

  // ─── Tracking ─────────────────────────────────────────────

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
