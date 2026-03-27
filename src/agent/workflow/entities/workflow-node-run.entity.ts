import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { WorkflowRun } from './workflow-run.entity';
import { WorkflowNode } from './workflow-node.entity';

export enum WorkflowNodeRunStatus {
  RUNNING = 'running',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  DELETE = 'delete',
}

@Entity('workflow_node_runs')
export class WorkflowNodeRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workflow_run_id', type: 'uuid' })
  workflowRunId: string;

  @ManyToOne(() => WorkflowRun, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workflow_run_id' })
  workflowRun: WorkflowRun;

  @Column({ name: 'node_id', type: 'uuid' })
  nodeId: string;

  @ManyToOne(() => WorkflowNode, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'node_id' })
  node: WorkflowNode;

  @Column({ name: 'attempt_no', type: 'int' })
  attemptNo: number;

  @Column({ name: 'resolved_prompt', type: 'text', nullable: true })
  resolvedPrompt: string | null;

  @Column({ name: 'resolved_command', type: 'text', nullable: true })
  resolvedCommand: string | null;

  @Column({
    type: 'enum',
    enum: WorkflowNodeRunStatus,
    default: WorkflowNodeRunStatus.RUNNING,
  })
  status: WorkflowNodeRunStatus;

  @Column({ type: 'jsonb', nullable: true })
  output: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ name: 'duration_ms', type: 'int', default: 0 })
  durationMs: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
