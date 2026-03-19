import { SetMetadata } from '@nestjs/common';
import { SkillCategory, SkillType } from '../interfaces/skill-runner.interface';
import { ModelTier } from '../../pipeline/model-router/model-tier.enum';

export const SKILL_METADATA = 'SKILL_METADATA';

export interface SkillMetadata {
  code: string;
  name: string;
  description: string;
  category: SkillCategory;
  parametersSchema?: Record<string, unknown>;
  ownerOnly?: boolean;
  /** Model tier tối thiểu để gọi skill này (default: CHEAP) */
  minModelTier?: ModelTier;
}

/**
 * Decorator để đánh dấu một class là built-in code skill.
 * Auto-discovered bởi SkillsService khi module init.
 *
 * @example
 * ```ts
 * @RegisterSkill({
 *   code: 'web_search',
 *   name: 'Web Search',
 *   description: 'Search the web for real-time information',
 *   category: SkillCategory.WEB,
 *   parametersSchema: {
 *     type: 'object',
 *     properties: { query: { type: 'string' } },
 *     required: ['query'],
 *   },
 * })
 * @Injectable()
 * export class WebSearchSkill implements ISkillRunner { ... }
 * ```
 */
export function RegisterSkill(metadata: SkillMetadata): ClassDecorator {
  return (target) => {
    SetMetadata(SKILL_METADATA, metadata)(target);
  };
}
