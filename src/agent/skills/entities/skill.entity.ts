import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ModelTier } from '../../pipeline/model-router/model-tier.enum';
import { SkillCategory } from '../interfaces/skill-runner.interface';

@Entity('skills_registry')
export class Skill {
  @PrimaryGeneratedColumn({ name: 'skill_id' })
  id: number;

  @Column({ name: 'skill_code', unique: true })
  code: string;

  /** Tên kỹ thuật tiếng Anh (vd. "Browser Automation") */
  @Column({ name: 'skill_name' })
  name: string;

  /** Tên hiển thị thân thiện (vd. "Sử dụng trình duyệt") — nullable cho skill cũ */
  @Column({ name: 'display_name', type: 'varchar', nullable: true })
  displayName: string | null;

  @Column({ type: 'text' })
  description: string;

  @Column({ name: 'file_path', nullable: true })
  filePath: string | null;

  @Column({ name: 'sample_code', type: 'varchar', nullable: true })
  sampleCode: string | null;

  @Column({ name: 'parameters_schema', type: 'json', nullable: true })
  parametersSchema: Record<string, any>;

  @Column({
    name: 'category',
    type: 'enum',
    enum: SkillCategory,
    default: SkillCategory.CUSTOM,
  })
  category: SkillCategory;

  @Column({
    name: 'min_model_tier',
    type: 'enum',
    enum: ModelTier,
    default: ModelTier.CHEAP,
  })
  minModelTier: ModelTier;

  /** Chỉ owner mới được dùng skill này */
  @Column({ name: 'owner_only', default: false })
  ownerOnly: boolean;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  /**
   * Hiển thị trong catalog cho user chọn khi tạo task_steps.
   * false = skill nội bộ/hệ thống (exec, file_read, cron_manage, ...) —
   * vẫn hoạt động bình thường, chỉ ẩn khỏi danh sách gợi ý.
   */
  @Column({ name: 'is_display', default: true })
  isDisplay: boolean;

  /** built_in = skill code tích hợp; shared = skill thư mục _shared/skills */
  @Column({ name: 'skill_type', type: 'varchar', default: 'built_in' })
  skillType: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
