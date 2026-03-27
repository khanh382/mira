import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum ModelPolicyScope {
  GLOBAL = 'global',
}

@Entity('model_policies')
@Index(['scope', 'signature'], { unique: true })
@Index(['intent'])
@Index(['updatedAt'])
export class ModelPolicy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: ModelPolicyScope, default: ModelPolicyScope.GLOBAL })
  scope: ModelPolicyScope;

  /**
   * Signature used for matching:
   * - intent + optional primarySkillHint
   * Example: "tool_call|browser"
   */
  @Column({ type: 'varchar', length: 120 })
  signature: string;

  @Column({ type: 'varchar', length: 32 })
  intent: string;

  @Column({ name: 'primary_skill', type: 'varchar', length: 80, nullable: true })
  primarySkill: string | null;

  /** Preferred tier (cheap/skill/processor/expert). Null => keep default tiering. */
  @Column({ name: 'preferred_tier', type: 'varchar', length: 32, nullable: true })
  preferredTier: string | null;

  /** Preferred model id (e.g. "openai/gpt-4o-mini"). Null => router picks within tier. */
  @Column({ name: 'preferred_model', type: 'varchar', length: 120, nullable: true })
  preferredModel: string | null;

  /** Owner feedback counters (global learning source). */
  @Column({ name: 'ok_count', type: 'int', default: 0 })
  okCount: number;

  @Column({ name: 'bad_count', type: 'int', default: 0 })
  badCount: number;

  @Column({ name: 'last_feedback_by_uid', type: 'int', nullable: true })
  lastFeedbackByUid: number | null;

  @Column({ name: 'last_feedback_at', type: 'timestamptz', nullable: true })
  lastFeedbackAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

