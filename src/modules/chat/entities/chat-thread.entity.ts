import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { ChatMessage } from './chat-message.entity';

export enum ChatPlatform {
  WEB = 'web',
  TELEGRAM = 'telegram',
  ZALO = 'zalo',
  DISCORD = 'discord',
  SLACK = 'slack',
  FACEBOOK = 'facebook',
}

@Entity('chat_threads')
export class ChatThread {
  @PrimaryColumn({ name: 'thread_id', type: 'uuid' })
  id: string;

  @Column({ name: 'uid' })
  userId: number;

  @ManyToOne(() => User, (user) => user.chatThreads)
  @JoinColumn({ name: 'uid' })
  user: User;

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
  title: string;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  /**
   * Khi set: tin nhắn tiếp theo trên thread này được proxy tới OpenClaw (chỉ chủ bot, không grantee).
   * null = agent hệ thống (pipeline nội bộ).
   */
  @Column({ name: 'active_openclaw_oa_id', type: 'int', nullable: true })
  activeOpenclawAgentId: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => ChatMessage, (msg) => msg.thread)
  messages: ChatMessage[];
}
