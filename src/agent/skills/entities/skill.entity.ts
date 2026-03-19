import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ModelTier } from '../../pipeline/model-router/model-tier.enum';

@Entity('skills_registry')
export class Skill {
  @PrimaryGeneratedColumn({ name: 'skill_id' })
  id: number;

  @Column({ name: 'skill_code', unique: true })
  code: string;

  @Column({ name: 'skill_name' })
  name: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ name: 'file_path' })
  filePath: string;

  @Column({ name: 'parameters_schema', type: 'json', nullable: true })
  parametersSchema: Record<string, any>;

  @Column({
    name: 'min_model_tier',
    type: 'enum',
    enum: ModelTier,
    default: ModelTier.CHEAP,
  })
  minModelTier: ModelTier;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
