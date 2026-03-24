import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { Task } from './task.entity';
import { User } from '../../users/entities/user.entity';
import { TaskRunStep } from './task-run-step.entity';

export enum TaskRunStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum TaskRunTrigger {
  MANUAL = 'manual',
  CRON = 'cron',
  WORKFLOW = 'workflow',
  CHAT = 'chat',
}

@Entity('task_runs')
export class TaskRun {
  @PrimaryColumn({ name: 'run_id', type: 'uuid' })
  id: string;

  @Column({ name: 'task_id' })
  taskId: number;

  @ManyToOne(() => Task, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task: Task;

  @Column({ name: 'uid' })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'uid' })
  user: User;

  @Column({
    name: 'status',
    type: 'enum',
    enum: TaskRunStatus,
    default: TaskRunStatus.PENDING,
  })
  status: TaskRunStatus;

  @Column({
    name: 'trigger',
    type: 'enum',
    enum: TaskRunTrigger,
    default: TaskRunTrigger.MANUAL,
  })
  trigger: TaskRunTrigger;

  @Column({ name: 'current_step', default: 0 })
  currentStep: number;

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

  @OneToMany(() => TaskRunStep, (s) => s.run)
  steps: TaskRunStep[];
}
