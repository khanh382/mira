import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from './user.entity';
import { UserPreference } from './user-preference.entity';
import { ChatThread } from '../../chat/entities/chat-thread.entity';

export type PreferenceEvidenceType =
  | 'explicit'
  | 'inferred'
  | 'corrected'
  | 'reinforced';

@Index('IDX_pref_log_user', ['userId'])
@Entity('user_preference_logs')
export class UserPreferenceLog {
  @PrimaryGeneratedColumn('uuid', { name: 'pl_id' })
  id: string;

  @Column({ name: 'pref_id', type: 'uuid' })
  preferenceId: string;

  @ManyToOne(() => UserPreference, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pref_id' })
  preference: UserPreference;

  @Column({ name: 'uid' })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'uid' })
  user: User;

  @Column({ name: 'thread_id', type: 'uuid' })
  threadId: string;

  @ManyToOne(() => ChatThread, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_id' })
  thread: ChatThread;

  @Column({ name: 'evidence_type', type: 'varchar', length: 32 })
  evidenceType: PreferenceEvidenceType;

  @Column({ name: 'evidence_text', type: 'text', nullable: true })
  evidenceText: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
