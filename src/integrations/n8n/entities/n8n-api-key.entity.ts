import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../../modules/users/entities/user.entity';

@Entity('n8n_api_keys')
@Index(['tokenHash'], { unique: true })
@Index(['userId', 'revokedAt'])
export class N8nApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'uid', type: 'int' })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'uid' })
  user: User;

  /** Human label (e.g. "n8n-prod"). */
  @Column({ type: 'varchar', length: 120, default: 'default' })
  label: string;

  /** sha256(hex) of the raw API key token. */
  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash: string;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

