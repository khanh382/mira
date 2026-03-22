import {
  Entity,
  PrimaryColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { OpenclawAgent } from '../../openclaw-agents/entities/openclaw-agent.entity';
import { AgentWorkflowRun } from './agent-workflow-run.entity';

export enum AgentWorkflowRunStepStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

@Entity('agent_workflow_run_steps')
export class AgentWorkflowRunStep {
  @PrimaryColumn({ name: 'wrs_id', type: 'uuid' })
  id: string;

  @Column({ name: 'wr_id', type: 'uuid' })
  runId: string;

  @ManyToOne(() => AgentWorkflowRun, (r) => r.steps, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'wr_id' })
  run: AgentWorkflowRun;

  @Column({ name: 'step_index' })
  stepIndex: number;

  @Column({ name: 'oa_id' })
  agentId: number;

  @ManyToOne(() => OpenclawAgent, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'oa_id' })
  agent: OpenclawAgent;

  @Column({
    name: 'wrs_status',
    type: 'enum',
    enum: AgentWorkflowRunStepStatus,
    default: AgentWorkflowRunStepStatus.PENDING,
  })
  status: AgentWorkflowRunStepStatus;

  @Column({ name: 'wrs_input', type: 'text' })
  inputSnapshot: string;

  @Column({ name: 'wrs_output', type: 'text', nullable: true })
  output: string | null;

  @Column({ name: 'wrs_error', type: 'text', nullable: true })
  error: string | null;

  /** Tên agent tại thời điểm chạy (snapshot). */
  @Column({ name: 'oa_name_snapshot', type: 'varchar', length: 255, nullable: true })
  oaNameSnapshot: string | null;

  /** Sở trường (oa_expertise) tại thời điểm chạy — cố định trong lịch sử. */
  @Column({ name: 'oa_expertise_snapshot', type: 'text', nullable: true })
  oaExpertiseSnapshot: string | null;

  /** Mở rộng (ví dụ token, tag) cho tính năng sau. */
  @Column({ name: 'wrs_metadata', type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ name: 'wrs_started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'wrs_finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
