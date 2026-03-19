import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  OneToMany,
} from 'typeorm';
import { BotUser } from '../../bot-users/entities/bot-user.entity';
import { ChatThread } from '../../chat/entities/chat-thread.entity';
import { ChatMessage } from '../../chat/entities/chat-message.entity';

export enum UserLevel {
  OWNER = 'owner',
  COLLEAGUE = 'colleague',
  CLIENT = 'client',
}

export enum UserStatus {
  ACTIVE = 'active',
  BLOCK = 'block',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn({ name: 'uid' })
  uid: number;

  @Column({ unique: true })
  identifier: string;

  @Column({ unique: true })
  uname: string;

  @Column({ unique: true })
  email: string;

  @Column({ name: 'telegram_id', unique: true, nullable: true })
  telegramId: string;

  @Column({ name: 'zalo_id', unique: true, nullable: true })
  zaloId: string;

  @Column({ name: 'discord_id', unique: true, nullable: true })
  discordId: string;

  @Column({ name: 'slack_id', unique: true, nullable: true })
  slackId: string;

  @Column({ name: 'facebook_id', unique: true, nullable: true })
  facebookId: string;

  @Column({ name: 'ggauth_token', unique: true, nullable: true })
  ggauthToken: string;

  @Column()
  password: string;

  @Column({ name: 'active_email', default: false })
  activeEmail: boolean;

  @Column({ name: 'use_ggauth', default: false })
  useGgauth: boolean;

  @Column({ type: 'enum', enum: UserLevel, default: UserLevel.CLIENT })
  level: UserLevel;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.ACTIVE })
  status: UserStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'update_at' })
  updateAt: Date;

  @OneToOne(() => BotUser, (botUser) => botUser.user)
  botUser: BotUser;

  @OneToMany(() => ChatThread, (thread) => thread.user)
  chatThreads: ChatThread[];

  @OneToMany(() => ChatMessage, (msg) => msg.user)
  chatMessages: ChatMessage[];
}
