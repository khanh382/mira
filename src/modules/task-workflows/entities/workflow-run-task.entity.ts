import {
  Entity,
  PrimaryColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { WorkflowRun } from './workflow-run.entity';

export enum WorkflowRunTaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

@Entity('workflow_run_tasks')
export class WorkflowRunTask {
  @PrimaryColumn({ name: 'wrt_id', type: 'uuid' })
  id: string;

  @Column({ name: 'wfr_id', type: 'uuid' })
  workflowRunId: string;

  @ManyToOne(() => WorkflowRun, (r) => r.runTasks, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'wfr_id' })
  workflowRun: WorkflowRun;

  @Column({ name: 'task_id' })
  taskId: number;

  @Column({ name: 'task_order' })
  taskOrder: number;

  /** FK nullable — tạo sau khi task_run được enqueue */
  @Column({ name: 'task_run_id', type: 'uuid', nullable: true })
  taskRunId: string | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: WorkflowRunTaskStatus,
    default: WorkflowRunTaskStatus.PENDING,
  })
  status: WorkflowRunTaskStatus;

  @Column({ name: 'error', type: 'text', nullable: true })
  error: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
