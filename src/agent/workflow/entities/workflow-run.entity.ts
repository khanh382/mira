import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../../modules/users/entities/user.entity';
import { Workflow } from './workflow.entity';

export enum WorkflowRunStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  DELETE = 'delete',
}

@Entity('workflow_runs')
export class WorkflowRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workflow_id', type: 'uuid' })
  workflowId: string;

  @ManyToOne(() => Workflow, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workflow_id' })
  workflow: Workflow;

  @Column({ name: 'uid', type: 'int' })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'uid' })
  user: User;

  @Column({ name: 'input_payload', type: 'jsonb', nullable: true })
  inputPayload: Record<string, unknown> | null;

  @Column({
    type: 'enum',
    enum: WorkflowRunStatus,
    default: WorkflowRunStatus.PENDING,
  })
  status: WorkflowRunStatus;

  @Column({ name: 'current_node_id', type: 'uuid', nullable: true })
  currentNodeId: string | null;

  @Column({ name: 'final_output', type: 'jsonb', nullable: true })
  finalOutput: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
