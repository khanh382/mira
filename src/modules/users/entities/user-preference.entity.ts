import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { User } from './user.entity';

export type PreferenceCategory =
  | 'communication'
  | 'tool_usage'
  | 'response_format'
  | 'domain_knowledge'
  | 'scheduling'
  | 'delegation';

@Unique('UQ_user_pref_cat_key', ['userId', 'category', 'key'])
@Index('IDX_user_pref_user_confidence', ['userId', 'confidence'])
@Entity('user_preferences')
export class UserPreference {
  @PrimaryGeneratedColumn('uuid', { name: 'pref_id' })
  id: string;

  @Column({ name: 'uid' })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'uid' })
  user: User;

  @Column({ name: 'category', type: 'varchar', length: 64 })
  category: PreferenceCategory;

  @Column({ name: 'pref_key', type: 'varchar', length: 255 })
  key: string;

  @Column({ name: 'pref_value', type: 'text' })
  value: string;

  /** 0.0–1.0: mức độ tin cậy dựa trên số lần xuất hiện + recency. */
  @Column({ name: 'confidence', type: 'float', default: 0.5 })
  confidence: number;

  @Column({ name: 'evidence_count', type: 'int', default: 1 })
  evidenceCount: number;

  /** Preference >= 5 evidence + confidence >= 0.8 được đánh dấu stable (không decay). */
  @Column({ name: 'is_stable', type: 'boolean', default: false })
  isStable: boolean;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
