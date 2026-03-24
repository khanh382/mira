import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Task } from './task.entity';
import { OpenclawAgent } from '../../openclaw-agents/entities/openclaw-agent.entity';

export enum StepExecutorType {
  INTERNAL = 'internal',
  OPENCLAW = 'openclaw',
}

export enum StepOnFailure {
  STOP = 'stop',
  SKIP = 'skip',
  CONTINUE = 'continue',
}

@Entity('task_steps')
export class TaskStep {
  @PrimaryGeneratedColumn({ name: 'step_id' })
  id: number;

  @Column({ name: 'task_id' })
  taskId: number;

  @ManyToOne(() => Task, (t) => t.steps, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task: Task;

  @Column({ name: 'step_order' })
  stepOrder: number;

  @Column({ name: 'name' })
  name: string;

  @Column({
    name: 'executor_type',
    type: 'enum',
    enum: StepExecutorType,
    default: StepExecutorType.INTERNAL,
  })
  executorType: StepExecutorType;

  /** Gợi ý skill code = mã @RegisterSkill (vd. browser, web_search) — không dùng /browser; nếu lưu /browser runtime vẫn bỏ /. Nullable = agent tự chọn tool. */
  @Column({ name: 'skill_code', type: 'varchar', nullable: true })
  skillCode: string | null;

  /** OpenClaw agent id — bắt buộc khi executor_type = 'openclaw'. */
  @Column({ name: 'oa_id', nullable: true })
  oaId: number | null;

  @ManyToOne(() => OpenclawAgent, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'oa_id' })
  openclawAgent: OpenclawAgent | null;

  @Column({ name: 'prompt', type: 'text' })
  prompt: string;

  /** Số lần retry thêm sau lần đầu thất bại (0 = không retry). */
  @Column({ name: 'retry_count', default: 0 })
  retryCount: number;

  @Column({ name: 'timeout_ms', default: 120000 })
  timeoutMs: number;

  @Column({
    name: 'on_failure',
    type: 'enum',
    enum: StepOnFailure,
    default: StepOnFailure.STOP,
  })
  onFailure: StepOnFailure;
}
