import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { BotUser } from './bot-user.entity';
import { User } from '../../users/entities/user.entity';

export enum BotPlatform {
  TELEGRAM = 'telegram',
  DISCORD = 'discord',
  SLACK = 'slack',
  ZALO = 'zalo',
}

/**
 * Quản lý quyền truy cập bot.
 *
 * Mặc định: bot của user chỉ cho phép user đó (theo platform_id trong bảng users).
 * Bảng này lưu các platform_id KHÁC được cấp quyền truy cập.
 *
 * Flow cấp quyền (giống OpenClaw allowFrom):
 * 1. Owner tạo grant → hệ thống sinh verification_code
 * 2. Người được mời nhắn mã code vào bot
 * 3. Bot verify code → đánh dấu is_verified = true
 * 4. Từ đó platform_user_id đó được phép tương tác
 */
@Entity('bot_access_grants')
export class BotAccessGrant {
  @PrimaryGeneratedColumn({ name: 'grant_id' })
  id: number;

  @Column({ name: 'bu_id' })
  botUserId: number;

  @ManyToOne(() => BotUser, (bu) => bu.accessGrants)
  @JoinColumn({ name: 'bu_id' })
  botUser: BotUser;

  @Column({ type: 'enum', enum: BotPlatform })
  platform: BotPlatform;

  @Column({ name: 'platform_user_id' })
  platformUserId: string;

  @Column({ name: 'granted_by' })
  grantedBy: number;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'granted_by' })
  granter: User;

  @Column({ name: 'verification_code', nullable: true })
  verificationCode: string;

  @Column({ name: 'is_verified', default: false })
  isVerified: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
