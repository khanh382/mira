import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { AgentWorkflowStep } from './agent-workflow-step.entity';

@Entity('agent_workflows')
export class AgentWorkflow {
  @PrimaryGeneratedColumn({ name: 'wf_id' })
  id: number;

  @Column({ name: 'wf_uid' })
  ownerUserId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'wf_uid' })
  owner: User;

  @Column({ name: 'wf_name' })
  name: string;

  @Column({ name: 'wf_description', type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'wf_enabled', default: true })
  enabled: boolean;

  @Column({ name: 'wf_cron_expression', type: 'varchar', length: 128, nullable: true })
  cronExpression: string | null;

  @Column({ name: 'wf_cron_enabled', default: false })
  cronEnabled: boolean;

  @Column({ name: 'wf_last_cron_at', type: 'timestamptz', nullable: true })
  lastCronAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => AgentWorkflowStep, (s) => s.workflow)
  steps: AgentWorkflowStep[];
}
