import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum AgentRunOutcome {
  UNKNOWN = 'unknown',
  OK = 'ok',
  BAD = 'bad',
}

@Entity('agent_runs')
@Index(['userId', 'createdAt'])
@Index(['userId', 'threadId', 'createdAt'])
@Index(['userId', 'intent', 'createdAt'])
export class AgentRun {
  /** Pipeline runId (uuidv4) */
  @PrimaryColumn({ name: 'run_id', type: 'uuid' })
  runId: string;

  @Column({ name: 'uid', type: 'int' })
  userId: number;

  /** For scheduled tasks we may use a synthetic thread id like `task:<code>` */
  @Column({ name: 'thread_id', type: 'varchar', length: 80 })
  threadId: string;

  @Column({ name: 'source_channel_id', type: 'varchar', length: 32 })
  sourceChannelId: string;

  @Column({ name: 'intent', type: 'varchar', length: 32, nullable: true })
  intent: string | null;

  @Column({ name: 'tier', type: 'varchar', length: 32, nullable: true })
  tier: string | null;

  @Column({ name: 'model', type: 'varchar', length: 120, nullable: true })
  model: string | null;

  @Column({ name: 'tokens_used', type: 'int', default: 0 })
  tokensUsed: number;

  /** Redacted preview of the user request (for /retry). */
  @Column({ name: 'request_preview', type: 'text', nullable: true })
  requestPreview: string | null;

  @Column({ name: 'stage', type: 'varchar', length: 64, nullable: true })
  stage: string | null;

  @Column({ name: 'error', type: 'text', nullable: true })
  error: string | null;

  /** Tool calls summary for this run (redacted by each skill). */
  @Column({ name: 'tool_calls', type: 'jsonb', nullable: true })
  toolCalls:
    | Array<{
        skillCode: string;
        success?: boolean;
        durationMs?: number;
        dataSize?: number;
      }>
    | null;

  @Column({
    name: 'user_outcome',
    type: 'enum',
    enum: AgentRunOutcome,
    default: AgentRunOutcome.UNKNOWN,
  })
  userOutcome: AgentRunOutcome;

  @Column({ name: 'user_feedback_text', type: 'text', nullable: true })
  userFeedbackText: string | null;

  @Column({ name: 'user_feedback_at', type: 'timestamptz', nullable: true })
  userFeedbackAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

