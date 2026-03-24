import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { Workflow } from './workflow.entity';
import { User } from '../../users/entities/user.entity';
import { WorkflowRunTask } from './workflow-run-task.entity';

export enum WorkflowRunStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum WorkflowRunTrigger {
  MANUAL = 'manual',
  CRON = 'cron',
  CHAT = 'chat',
}

@Entity('workflow_runs')
export class WorkflowRun {
  @PrimaryColumn({ name: 'wfr_id', type: 'uuid' })
  id: string;

  @Column({ name: 'wf_id' })
  workflowId: number;

  @ManyToOne(() => Workflow, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'wf_id' })
  workflow: Workflow;

  @Column({ name: 'uid' })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'uid' })
  user: User;

  @Column({
    name: 'status',
    type: 'enum',
    enum: WorkflowRunStatus,
    default: WorkflowRunStatus.PENDING,
  })
  status: WorkflowRunStatus;

  @Column({
    name: 'trigger',
    type: 'enum',
    enum: WorkflowRunTrigger,
    default: WorkflowRunTrigger.MANUAL,
  })
  trigger: WorkflowRunTrigger;

  @Column({ name: 'current_task_order', default: 0 })
  currentTaskOrder: number;

  @Column({ name: 'error', type: 'text', nullable: true })
  error: string | null;

  @Column({ name: 'summary', type: 'text', nullable: true })
  summary: string | null;

  @Column({ name: 'context', type: 'jsonb', nullable: true })
  context: Record<string, unknown> | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @OneToMany(() => WorkflowRunTask, (t) => t.workflowRun)
  runTasks: WorkflowRunTask[];
}
