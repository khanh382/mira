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
import { ChatThread } from './chat-thread.entity';

export enum MessageRole {
  SYSTEM = 'system',
  USER = 'user',
  ASSISTANT = 'assistant',
  TOOL = 'tool',
}

@Index(['threadId', 'createdAt'])
@Entity('chat_messages')
export class ChatMessage {
  @PrimaryColumn({ name: 'msg_id', type: 'uuid' })
  id: string;

  @Column({ name: 'thread_id' })
  threadId: string;

  @ManyToOne(() => ChatThread, (thread) => thread.messages)
  @JoinColumn({ name: 'thread_id' })
  thread: ChatThread;

  @Column({ name: 'uid' })
  userId: number;

  @Column({ name: 'telegram_id', type: 'varchar', nullable: true })
  telegramId?: string;

  @Column({ name: 'zalo_id', type: 'varchar', nullable: true })
  zaloId?: string;

  @Column({ name: 'discord_id', type: 'varchar', nullable: true })
  discordId?: string;

  @ManyToOne(() => User, (user) => user.chatMessages)
  @JoinColumn({ name: 'uid' })
  user: User;

  @Column({ type: 'enum', enum: MessageRole })
  role: MessageRole;

  @Column({ type: 'text' })
  content: string;

  @Column({ name: 'tokens_used', default: 0 })
  tokensUsed: number;

  @Index()
  @Column({ name: 'is_vectorized', default: false })
  isVectorized: boolean;

  @Column({ name: 'is_exported', default: false })
  isExported: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
