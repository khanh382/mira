import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum OpenclawAgentStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
}

/**
 * Đăng ký một instance OpenClaw Gateway (user tự host).
 * Chỉ user sở hữu bản ghi (oa_uid) được proxy chat qua agent này; không gộp với bot_access_grants.
 *
 * @see https://github.com/openclaw/openclaw — Gateway WS control plane, session model
 */
@Entity('openclaw_agents')
export class OpenclawAgent {
  @PrimaryGeneratedColumn({ name: 'oa_id' })
  id: number;

  @Column({ name: 'oa_name' })
  name: string;

  @Column({ name: 'oa_uid' })
  ownerUserId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'oa_uid' })
  owner: User;

  @Column({ name: 'oa_domain' })
  domain: string;

  /** Cổng Gateway (OpenClaw mặc định 18789 trong docs upstream) */
  @Column({ name: 'oa_port', type: 'varchar', length: 16 })
  port: string;

  @Column({ name: 'oa_use_tls', default: false })
  useTls: boolean;

  /**
   * Đường dẫn HTTP POST relay (backend → shim trước OpenClaw Gateway).
   * Mặc định dùng biến môi trường OPENCLAW_DEFAULT_CHAT_PATH nếu null.
   */
  @Column({ name: 'oa_chat_path', type: 'varchar', nullable: true })
  chatPath: string | null;

  @Column({ name: 'oa_token_gateway', type: 'varchar', nullable: true })
  gatewayToken: string | null;

  @Column({ name: 'oa_password_gateway', type: 'varchar', nullable: true })
  gatewayPassword: string | null;

  @Column({ name: 'oa_expertise', type: 'text', nullable: true })
  expertise: string | null;

  @Column({
    name: 'oa_status',
    type: 'enum',
    enum: OpenclawAgentStatus,
    default: OpenclawAgentStatus.ACTIVE,
  })
  status: OpenclawAgentStatus;

  @Column({ name: 'oa_last_health_at', type: 'timestamptz', nullable: true })
  lastHealthAt: Date | null;

  @Column({ name: 'oa_last_error', type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
