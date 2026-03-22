import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { OpenclawThread } from './openclaw-thread.entity';

export enum OpenclawMessageRole {
  SYSTEM = 'system',
  USER = 'user',
  ASSISTANT = 'assistant',
  TOOL = 'tool',
}

/**
 * Lịch sử chỉ dùng cho luồng OpenClaw; không ghi vào chat_messages / workspace file.
 */
@Index(['threadId', 'createdAt'])
@Entity('openclaw_messages')
export class OpenclawMessage {
  @PrimaryColumn({ name: 'ocm_id', type: 'uuid' })
  id: string;

  @Column({ name: 'oct_id', type: 'uuid' })
  threadId: string;

  @ManyToOne(() => OpenclawThread, (t) => t.messages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'oct_id' })
  thread: OpenclawThread;

  /** Chủ sở hữu cuộc hội thoại (trùng uid thread; không dùng grantee) */
  @Column({ name: 'uid' })
  ownerUserId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'uid' })
  owner: User;

  @Column({ type: 'enum', enum: OpenclawMessageRole })
  role: OpenclawMessageRole;

  @Column({ type: 'text' })
  content: string;

  /** Snapshot tên agent để hiển thị prefix &lt;name&gt;: … */
  @Column({ name: 'oa_display_name', type: 'varchar', nullable: true })
  agentDisplayName: string | null;

  @Column({ type: 'jsonb', nullable: true })
  extra: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
