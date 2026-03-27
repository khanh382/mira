import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('google_connections')
export class GoogleConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'uid', type: 'int', unique: true })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'uid' })
  user: User;

  @Column({ name: 'google_email', type: 'varchar', length: 255, nullable: true })
  googleEmail: string | null;

  @Column({ name: 'console_credentials_json', type: 'text', nullable: true })
  consoleCredentialsJson: string | null;

  /**
   * Persisted gogcli state (tokens/keyring/config) as a file map.
   * Keys are relative paths under the gog config dir. Values are base64 content.
   */
  @Column({ name: 'gog_state', type: 'jsonb', nullable: true })
  gogState: Record<string, string> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

