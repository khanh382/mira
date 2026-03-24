import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from './user.entity';

export enum UserCodeType {
  ACTIVE_EMAIL = 'active-email',
  LOGIN = 'login',
  RESET_PASSWORD = 'reset-password',
  ADVANCED = 'advanced',
}

export enum UserCodePlace {
  EMAIL = 'email',
  TELEGRAM = 'telegram',
  ZALO = 'zalo',
  DISCORD = 'discord',
}

@Entity('user_codes')
@Index(['ucUserId', 'ucType', 'ucLife'])
export class UserCode {
  @PrimaryGeneratedColumn({ name: 'uc_id' })
  ucId: number;

  @Column({ name: 'uc_value', type: 'varchar' })
  ucValue: string;

  @Column({ name: 'uc_type', type: 'enum', enum: UserCodeType })
  ucType: UserCodeType;

  @Column({
    name: 'uc_place',
    type: 'enum',
    enum: UserCodePlace,
    nullable: true,
  })
  ucPlace: UserCodePlace | null;

  @Column({ name: 'uc_expired_time', type: 'timestamp' })
  ucExpiredTime: Date;

  @Column({ name: 'uc_life', type: 'boolean', default: true })
  ucLife: boolean;

  @Column({ name: 'uc_user_id' })
  ucUserId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'uc_user_id' })
  user: User;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'update_at' })
  updateAt: Date;
}
