import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Workflow } from './workflow.entity';

export enum WorkflowNodeJoinMode {
  NONE = 'none',
  WAIT_ANY = 'wait_any',
  WAIT_ALL = 'wait_all',
}

@Entity('workflow_nodes')
@Index(['workflowId', 'name'], { unique: true })
export class WorkflowNode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workflow_id', type: 'uuid' })
  workflowId: string;

  @ManyToOne(() => Workflow, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workflow_id' })
  workflow: Workflow;

  @Column({ type: 'varchar', length: 160 })
  name: string;

  @Column({ name: 'prompt_template', type: 'text', nullable: true })
  promptTemplate: string | null;

  @Column({ name: 'tool_code', type: 'varchar', length: 120, nullable: true })
  toolCode: string | null;

  @Column({ name: 'command_code', type: 'text', nullable: true })
  commandCode: string | null;

  @Column({ name: 'model_override', type: 'varchar', length: 160, nullable: true })
  modelOverride: string | null;

  @Column({ name: 'max_attempts', type: 'int', default: 5 })
  maxAttempts: number;

  @Column({ name: 'timeout_ms', type: 'int', default: 120000 })
  timeoutMs: number;

  @Column({ name: 'output_schema', type: 'jsonb', nullable: true })
  outputSchema: Record<string, unknown> | null;

  @Column({
    name: 'join_mode',
    type: 'enum',
    enum: WorkflowNodeJoinMode,
    default: WorkflowNodeJoinMode.NONE,
  })
  joinMode: WorkflowNodeJoinMode;

  @Column({ name: 'join_expected', type: 'int', nullable: true })
  joinExpected: number | null;

  @Column({ name: 'pos_x', type: 'int', default: 0 })
  posX: number;

  @Column({ name: 'pos_y', type: 'int', default: 0 })
  posY: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
