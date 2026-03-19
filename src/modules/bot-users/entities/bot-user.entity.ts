import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { BotAccessGrant } from './bot-access-grant.entity';

@Entity('bot_users')
export class BotUser {
  @PrimaryGeneratedColumn({ name: 'bu_id' })
  id: number;

  @Column({ name: 'bu_uid', unique: true })
  userId: number;

  @OneToOne(() => User, (user) => user.botUser)
  @JoinColumn({ name: 'bu_uid' })
  user: User;

  @Column({ name: 'bu_telegram_bot_token', nullable: true })
  telegramBotToken: string;

  @Column({ name: 'bu_discord_bot_token', nullable: true })
  discordBotToken: string;

  @Column({ name: 'bu_slack_bot_token', nullable: true })
  slackBotToken: string;

  @Column({ name: 'bu_zalo_bot_token', nullable: true })
  zaloBotToken: string;

  @Column({ name: 'bu_google_console_cloud_json_path', nullable: true })
  googleConsoleCloudJsonPath: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'update_at' })
  updateAt: Date;

  @OneToMany(() => BotAccessGrant, (grant) => grant.botUser)
  accessGrants: BotAccessGrant[];
}
