import {
  Entity,
  PrimaryColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { TaskRun } from './task-run.entity';

export enum TaskRunStepStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

@Entity('task_run_steps')
export class TaskRunStep {
  @PrimaryColumn({ name: 'run_step_id', type: 'uuid' })
  id: string;

  @Column({ name: 'run_id', type: 'uuid' })
  runId: string;

  @ManyToOne(() => TaskRun, (r) => r.steps, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run: TaskRun;

  @Column({ name: 'step_index' })
  stepIndex: number;

  @Column({ name: 'executor_type', type: 'varchar' })
  executorType: string;

  @Column({ name: 'skill_code', type: 'varchar', nullable: true })
  skillCode: string | null;

  @Column({ name: 'oa_id', nullable: true })
  oaId: number | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: TaskRunStepStatus,
    default: TaskRunStepStatus.PENDING,
  })
  status: TaskRunStepStatus;

  @Column({ name: 'input_snapshot', type: 'text' })
  inputSnapshot: string;

  @Column({ name: 'output', type: 'text', nullable: true })
  output: string | null;

  @Column({ name: 'error', type: 'text', nullable: true })
  error: string | null;

  @Column({ name: 'attempt', default: 1 })
  attempt: number;

  @Column({ name: 'max_attempts', default: 1 })
  maxAttempts: number;

  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
