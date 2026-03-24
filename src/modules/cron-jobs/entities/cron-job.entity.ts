import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum CronJobTargetType {
  TASK = 'task',
  WORKFLOW = 'workflow',
}

@Entity('cron_jobs')
export class CronJob {
  @PrimaryGeneratedColumn({ name: 'cj_id' })
  id: number;

  @Column({ name: 'uid' })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'uid' })
  user: User;

  @Column({ name: 'name' })
  name: string;

  @Column({ name: 'cron_expression' })
  cronExpression: string;

  @Column({
    name: 'target_type',
    type: 'enum',
    enum: CronJobTargetType,
  })
  targetType: CronJobTargetType;

  /** ID của task hoặc workflow tùy target_type. */
  @Column({ name: 'target_id' })
  targetId: number;

  @Column({ name: 'enabled', default: true })
  enabled: boolean;

  @Column({ name: 'max_consecutive_failures', default: 3 })
  maxConsecutiveFailures: number;

  @Column({ name: 'consecutive_failures', default: 0 })
  consecutiveFailures: number;

  @Column({ name: 'last_run_at', type: 'timestamptz', nullable: true })
  lastRunAt: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
