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

export enum HttpTokenAuthType {
  API_KEY = 'api_key',
  BEARER = 'bearer',
  BASIC = 'basic',
}

@Entity('http_tokens')
export class HttpToken {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 120, unique: true })
  code: string;

  @Column({ type: 'varchar', length: 255 })
  domain: string;

  @Column({
    type: 'enum',
    enum: HttpTokenAuthType,
    default: HttpTokenAuthType.BEARER,
  })
  authType: HttpTokenAuthType;

  @Column({ name: 'header_name', type: 'varchar', length: 128, nullable: true })
  headerName: string | null;

  @Column({ type: 'text' })
  token: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  username: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ name: 'created_by_uid', type: 'int', nullable: true })
  createdByUid: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by_uid', referencedColumnName: 'uid' })
  createdBy: User | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
