import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { RegisterSkill } from '../../decorators/skill.decorator';
import { UsersService } from '../../../../modules/users/users.service';
import { UserLevel } from '../../../../modules/users/entities/user.entity';
import { WorkspaceService } from '../../../../gateway/workspace/workspace.service';
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
  constructor(
    private readonly usersService: UsersService,
    private readonly workspaceService: WorkspaceService,
  ) {}

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

    // ─── Access guard by role + brain scope ───────────────────────────
    const user = await this.usersService.findById(context.userId);
    if (!user) {
      return {
        success: false,
        error: 'User not found.',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const target = fs.realpathSync(filePath);
    const brainDir = path.resolve(this.workspaceService.getBrainDir());
    const sharedDir = path.resolve(path.join(brainDir, '_shared'));
    const ownUserDir = path.resolve(this.workspaceService.getUserDir(user.identifier));

    const isUnder = (root: string, p: string): boolean => {
      const r = path.resolve(root);
      const x = path.resolve(p);
      return x === r || x.startsWith(r + path.sep);
    };

    const deny = (msg: string): ISkillResult => ({
      success: false,
      error: msg,
      metadata: { durationMs: Date.now() - start },
    });

    // non-owner: chỉ đọc trong chính $BRAIN_DIR/<identifier>/, cấm _shared
    if (user.level !== UserLevel.OWNER) {
      if (!isUnder(ownUserDir, target)) {
        return deny(
          'Access denied: non-owner chỉ được đọc trong $BRAIN_DIR/<identifier>/ của chính mình.',
        );
      }
      if (isUnder(sharedDir, target)) {
        return deny('Access denied: non-owner không được đọc nội dung trong $BRAIN_DIR/_shared/.');
      }
    } else {
      // owner: cho phép đọc _shared + thư mục của chính owner.
      // Nếu đọc thư mục user khác thì chặn đường dẫn nhạy cảm.
      const underOwn = isUnder(ownUserDir, target);
      const underShared = isUnder(sharedDir, target);
      if (!underOwn && !underShared && isUnder(brainDir, target)) {
        const relBrain = path.relative(brainDir, target).replace(/\\/g, '/');
        const first = relBrain.split('/')[0] ?? '';
        if (first && first !== '_shared' && first !== user.identifier) {
          const relUnderOther = relBrain.slice(first.length + 1).toLowerCase();
          const sensitive =
            relUnderOther.startsWith('cookies/') ||
            relUnderOther.includes('/cookies/') ||
            /(^|\/)http[-_]?tokens?\.json$/i.test(relUnderOther);
          if (sensitive) {
            return deny(
              'Access denied: không được đọc đường dẫn nhạy cảm (cookies/http-tokens.json) của user khác.',
            );
          }
        }
      }
    }

    try {
      const raw = fs.readFileSync(target, 'utf-8');
      const truncated = raw.length > maxChars;
      const content = truncated ? raw.slice(0, maxChars) : raw;
      return {
        success: true,
        data: {
          filePath: target,
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
