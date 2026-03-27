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
import { WorkflowNode } from './workflow-node.entity';

@Entity('workflow_edges')
@Index(['workflowId', 'fromNodeId', 'priority'])
export class WorkflowEdge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workflow_id', type: 'uuid' })
  workflowId: string;

  @ManyToOne(() => Workflow, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workflow_id' })
  workflow: Workflow;

  @Column({ name: 'from_node_id', type: 'uuid' })
  fromNodeId: string;

  @ManyToOne(() => WorkflowNode, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'from_node_id' })
  fromNode: WorkflowNode;

  @Column({ name: 'to_node_id', type: 'uuid' })
  toNodeId: string;

  @ManyToOne(() => WorkflowNode, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'to_node_id' })
  toNode: WorkflowNode;

  @Column({ name: 'condition_expr', type: 'text', nullable: true })
  conditionExpr: string | null;

  @Column({ type: 'int', default: 100 })
  priority: number;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
