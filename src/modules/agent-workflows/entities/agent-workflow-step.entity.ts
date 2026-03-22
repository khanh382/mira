import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { OpenclawAgent } from '../../openclaw-agents/entities/openclaw-agent.entity';
import { AgentWorkflow } from './agent-workflow.entity';

@Entity('agent_workflow_steps')
export class AgentWorkflowStep {
  @PrimaryGeneratedColumn({ name: 'wfs_id' })
  id: number;

  @Column({ name: 'wf_id' })
  workflowId: number;

  @ManyToOne(() => AgentWorkflow, (w) => w.steps, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'wf_id' })
  workflow: AgentWorkflow;

  @Column({ name: 'wfs_order' })
  stepOrder: number;

  @Column({ name: 'oa_id' })
  agentId: number;

  @ManyToOne(() => OpenclawAgent, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'oa_id' })
  agent: OpenclawAgent;

  @Column({ name: 'wfs_input_text', type: 'text' })
  inputText: string;
}
