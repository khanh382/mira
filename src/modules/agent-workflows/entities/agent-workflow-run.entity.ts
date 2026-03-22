import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { AgentWorkflow } from './agent-workflow.entity';
import { AgentWorkflowRunStep } from './agent-workflow-run-step.entity';

export enum AgentWorkflowRunStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum AgentWorkflowRunTrigger {
  MANUAL = 'manual',
  CRON = 'cron',
}

@Entity('agent_workflow_runs')
export class AgentWorkflowRun {
  @PrimaryColumn({ name: 'wr_id', type: 'uuid' })
  id: string;

  @Column({ name: 'wf_id' })
  workflowId: number;

  @ManyToOne(() => AgentWorkflow, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'wf_id' })
  workflow: AgentWorkflow;

  @Column({ name: 'wr_uid' })
  ownerUserId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'wr_uid' })
  owner: User;

  @Column({
    name: 'wr_status',
    type: 'enum',
    enum: AgentWorkflowRunStatus,
    default: AgentWorkflowRunStatus.PENDING,
  })
  status: AgentWorkflowRunStatus;

  @Column({ name: 'wr_current_step', default: 0 })
  currentStep: number;

  @Column({ name: 'wr_error', type: 'text', nullable: true })
  error: string | null;

  /**
   * Tóm tắt kết quả lần chạy (thường là output bước cuối hoặc thông báo lỗi),
   * phục vụ tra cứu / system agent sau này.
   */
  @Column({ name: 'wr_summary', type: 'text', nullable: true })
  summary: string | null;

  /**
   * Dữ liệu tạm khi điều phối (JSON): ví dụ khóa `orchestration` — phase, bước cuối, preview output.
   * Có thể mở rộng sau cho system agent; không thay thế `agent_workflow_run_steps`.
   */
  @Column({ name: 'wr_context', type: 'jsonb', nullable: true })
  context: Record<string, unknown> | null;

  @Column({
    name: 'wr_trigger',
    type: 'enum',
    enum: AgentWorkflowRunTrigger,
    default: AgentWorkflowRunTrigger.MANUAL,
  })
  trigger: AgentWorkflowRunTrigger;

  @Column({ name: 'wr_started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'wr_finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @OneToMany(() => AgentWorkflowRunStep, (s) => s.run)
  steps: AgentWorkflowRunStep[];
}
