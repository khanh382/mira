import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
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
import { GogCliService } from './gog-cli.service';
import { UsersService } from '../../../../modules/users/users.service';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    email: {
      type: 'string',
      description:
        'Google account email dùng để chạy `gog auth add` (vd: user@gmail.com).',
    },
    mode: {
      type: 'string',
      description:
        'Chế độ auth với gog: remote_step1 (mặc định, trả auth URL), remote_step2 (hoàn tất từ authUrl), hoặc manual.',
      enum: ['remote_step1', 'remote_step2', 'manual'],
      default: 'remote_step1',
    },
    authUrl: {
      type: 'string',
      description:
        'Bắt buộc khi mode=remote_step2. Là URL redirect đầy đủ (loopback) lấy từ bước remote_step1.',
    },
  },
};

@RegisterSkill({
  code: 'google_auth_setup',
  name: 'Google Auth Setup',
  description:
    'Run initial Google auth for current user using previously uploaded Google Console OAuth JSON. ' +
    'This is required before most google_workspace operations.',
  category: SkillCategory.GOOGLE,
  parametersSchema: PARAMETERS_SCHEMA,
  minModelTier: ModelTier.SKILL,
})
@Injectable()
export class GoogleAuthSetupSkill implements ISkillRunner {
  private readonly logger = new Logger(GoogleAuthSetupSkill.name);

  constructor(
    private readonly gogCli: GogCliService,
    private readonly usersService: UsersService,
  ) {}

  get definition(): ISkillDefinition {
    return {
      code: 'google_auth_setup',
      name: 'Google Auth Setup',
      description: 'Setup gog credentials + auth add',
      category: SkillCategory.GOOGLE,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
      minModelTier: ModelTier.SKILL,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    let email = String(context.parameters.email || '').trim();
    const mode = String(context.parameters.mode || 'remote_step1').trim();
    const authUrl = String(context.parameters.authUrl || '').trim();

    // Security guard: if called from Telegram, require exact owner Telegram ID match.
    if (context.actorTelegramId) {
      const owner = await this.usersService.findById(context.userId);
      const ownerTg = (owner?.telegramId || '').trim();
      if (!ownerTg || ownerTg !== String(context.actorTelegramId).trim()) {
        return {
          success: false,
          error: 'Only owner Telegram ID can run google_auth_setup.',
          metadata: { durationMs: Date.now() - start },
        };
      }
    }

    const available = await this.gogCli.isAvailable();
    if (!available) {
      return {
        success: false,
        error: 'gogcli binary not installed',
        metadata: { durationMs: Date.now() - start },
      };
    }

    // If token already exists for this user, do not force oauth flow again.
    // This prevents the bot from repeatedly asking for email/authUrl after a
    // successful setup earlier (and keeps token usage idempotent).
    try {
      const authList = await this.gogCli.exec({
        userId: context.userId,
        args: ['auth', 'list'],
        timeout: 15000,
        json: true,
      });

      const accounts = (authList.data as any)?.accounts;
      if (authList.success && Array.isArray(accounts) && accounts.length > 0) {
        return {
          success: true,
          data: { accounts },
          error: null,
          metadata: {
            durationMs: Date.now() - start,
            skipped: true,
            reason: 'gog already has saved auth token for this user',
          },
        };
      }
    } catch {
      // Ignore; fall back to normal flow below.
    }

    // If email is not provided, infer from stored Google Console OAuth JSON.
    if (!email) {
      const credPath = await this.gogCli.getCredentialsPathForUser(
        context.userId,
      );
      if (!credPath) {
        return {
          success: false,
          error:
            'Missing parameter: email. Also cannot infer email from stored credentials JSON (bu_google_console_cloud_json_path not set or file missing).',
          metadata: { durationMs: Date.now() - start },
        };
      }

      let raw = '';
      try {
        raw = fs.readFileSync(credPath, 'utf-8');
      } catch {
        return {
          success: false,
          error: `Cannot read stored credentials file: ${credPath}`,
          metadata: { durationMs: Date.now() - start },
        };
      }

      try {
        const parsed = JSON.parse(raw);
        email =
          parsed?.client_email ||
          parsed?.service_account?.client_email ||
          parsed?.email ||
          parsed?.installed?.client_email ||
          parsed?.web?.client_email ||
          '';
      } catch {
        // ignore parse error, will fail below
      }

      email = String(email || '').trim();
      if (!email) {
        return {
          success: false,
          error:
            'Missing parameter: email. Could not infer an email from the stored credentials JSON.',
          metadata: { durationMs: Date.now() - start },
        };
      }
    }

    let result: Awaited<ReturnType<typeof this.gogCli.setupCredentials>>;
    if (mode === 'remote_step2') {
      if (!authUrl) {
        return {
          success: false,
          error: 'Missing parameter: authUrl (required for remote_step2).',
          metadata: { durationMs: Date.now() - start },
        };
      }
      result = await this.gogCli.setupCredentialsRemoteStep2(
        context.userId,
        email,
        authUrl,
      );
    } else if (mode === 'manual') {
      result = await this.gogCli.setupCredentials(context.userId, email);
    } else {
      result = await this.gogCli.setupCredentialsRemoteStep1(
        context.userId,
        email,
      );
    }

    return {
      success: result.success,
      data: result.data,
      error: result.error,
      metadata: {
        durationMs: Date.now() - start,
        stderr: (result as any).stderr,
      },
    };
  }
}
