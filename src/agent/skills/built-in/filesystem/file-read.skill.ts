import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { RegisterSkill } from '../../decorators/skill.decorator';
import {
  ISkillDefinition,
  ISkillExecutionContext,
  ISkillResult,
  ISkillRunner,
  SkillCategory,
  SkillType,
} from '../../interfaces/skill-runner.interface';
import { ModelTier } from '../../../pipeline/model-router/model-tier.enum';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    filePath: { type: 'string', description: 'Absolute path to local file' },
    maxChars: {
      type: 'number',
      description: 'Maximum characters to return (default 20000, max 120000)',
      default: 20000,
    },
  },
  required: ['filePath'],
};

const ALLOWED_EXT = new Set([
  '.json',
  '.jsonl',
  '.txt',
  '.md',
  '.csv',
  '.log',
  '.yaml',
  '.yml',
  '.xml',
]);

@RegisterSkill({
  code: 'file_read',
  name: 'File Reader',
  description:
    'Read text/JSON files from local filesystem by absolute path. ' +
    'Use for attachments saved on server (json, txt, md, csv, log).',
  category: SkillCategory.FILESYSTEM,
  parametersSchema: PARAMETERS_SCHEMA,
  minModelTier: ModelTier.CHEAP,
})
@Injectable()
export class FileReadSkill implements ISkillRunner {
  get definition(): ISkillDefinition {
    return {
      code: 'file_read',
      name: 'File Reader',
      description: 'Read text/JSON files from local filesystem',
      category: SkillCategory.FILESYSTEM,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
      minModelTier: ModelTier.CHEAP,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const filePath = String(context.parameters.filePath || '').trim();
    const maxCharsInput = Number(context.parameters.maxChars ?? 20000);
    const maxChars = Math.max(
      1000,
      Math.min(120000, Number.isFinite(maxCharsInput) ? maxCharsInput : 20000),
    );

    if (!path.isAbsolute(filePath)) {
      return {
        success: false,
        error: 'filePath must be an absolute path',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return {
        success: false,
        error: `Unsupported file extension: ${ext || '(none)'}`,
        metadata: { durationMs: Date.now() - start },
      };
    }

    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        error: `File not found: ${filePath}`,
        metadata: { durationMs: Date.now() - start },
      };
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const truncated = raw.length > maxChars;
      const content = truncated ? raw.slice(0, maxChars) : raw;
      return {
        success: true,
        data: {
          filePath,
          extension: ext,
          content,
          chars: raw.length,
          truncated,
        },
        metadata: { durationMs: Date.now() - start },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message ?? String(error),
        metadata: { durationMs: Date.now() - start },
      };
    }
  }
}
