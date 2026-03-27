import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum N8nDispatchStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  TIMED_OUT = 'TIMED_OUT',
}

@Entity('n8n_dispatches')
@Index(['userId', 'idempotencyKey'], { unique: true })
export class N8nDispatch {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  userId: number;

  @Column({ type: 'uuid', nullable: true })
  threadId: string | null;

  @Column({ type: 'varchar', length: 120 })
  workflowKey: string;

  @Column({ type: 'varchar', length: 180 })
  idempotencyKey: string;

  @Column({ type: 'varchar', length: 20, default: N8nDispatchStatus.PENDING })
  status: N8nDispatchStatus;

  @Column({ type: 'varchar', length: 40, nullable: true })
  dispatchNonce: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  n8nExecutionId: string | null;

  /** Optional: where to notify when completed (telegram/discord/zalo/slack/webchat). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  notifyChannelId: string | null;

  /** Optional: target id on platform; for webchat this may be null (we can emit by userId). */
  @Column({ type: 'varchar', length: 180, nullable: true })
  notifyTargetId: string | null;

  /** Redacted request snapshot (store minimal; do NOT store secrets). */
  @Column({ type: 'jsonb', nullable: true })
  requestSnapshot: Record<string, unknown> | null;

  /** Redacted result preview (safe for logs/history). */
  @Column({ type: 'text', nullable: true })
  resultPreview: string | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

