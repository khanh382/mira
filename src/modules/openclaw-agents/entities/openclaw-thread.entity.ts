import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import {
  ChatThread,
  ChatPlatform,
} from '../../chat/entities/chat-thread.entity';
import { OpenclawAgent } from './openclaw-agent.entity';
import { OpenclawMessage } from './openclaw-message.entity';

/**
 * Phiên chat tách biệt khỏi chat_threads / chat_messages khi user đang route tới OpenClaw.
 * Có thể gắn chat_thread_id (web/bot) để Gateway map cùng một “ô chat” với hệ system.
 */
@Index(['ownerUserId', 'agentId'])
@Index(['chatThreadId'])
@Entity('openclaw_threads')
export class OpenclawThread {
  @PrimaryColumn({ name: 'oct_id', type: 'uuid' })
  id: string;

  @Column({ name: 'uid' })
  ownerUserId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'uid' })
  owner: User;

  @Column({ name: 'oa_id' })
  agentId: number;

  @ManyToOne(() => OpenclawAgent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'oa_id' })
  agent: OpenclawAgent;

  /** Khớp thread UI bên chat_threads khi cùng khung chat (nullable nếu chỉ OpenClaw) */
  @Column({ name: 'chat_thread_id', type: 'uuid', nullable: true })
  chatThreadId: string | null;

  @ManyToOne(() => ChatThread, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'chat_thread_id' })
  chatThread: ChatThread | null;

  /**
   * Session phía OpenClaw Gateway (transcript / sessions_* trên upstream).
   * User yêu cầu session mới → tạo giá trị mới hoặc dòng thread mới tùy policy gateway.
   */
  @Column({ name: 'openclaw_session_key', type: 'varchar', nullable: true })
  openclawSessionKey: string | null;

  @Column({
    type: 'enum',
    enum: ChatPlatform,
    default: ChatPlatform.WEB,
  })
  platform: ChatPlatform;

  @Column({ name: 'telegram_id', type: 'varchar', nullable: true })
  telegramId?: string;

  @Column({ name: 'zalo_id', type: 'varchar', nullable: true })
  zaloId?: string;

  @Column({ name: 'discord_id', type: 'varchar', nullable: true })
  discordId?: string;

  @Column({ nullable: true })
  title: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => OpenclawMessage, (m) => m.thread)
  messages: OpenclawMessage[];
}
