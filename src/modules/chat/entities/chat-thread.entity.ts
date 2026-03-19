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

  @Column({ nullable: true })
  title: string;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => ChatMessage, (msg) => msg.thread)
  messages: ChatMessage[];
}
