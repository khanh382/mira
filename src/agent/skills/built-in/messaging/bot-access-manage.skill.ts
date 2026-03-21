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
import { BotAccessService } from '../../../../modules/bot-users/bot-access.service';
import { BotPlatform } from '../../../../modules/bot-users/entities/bot-access-grant.entity';
import { UsersService } from '../../../../modules/users/users.service';
import { WorkspaceService } from '../../../../gateway/workspace/workspace.service';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'approve_code', 'revoke', 'list'],
      description:
        'create = generate verification code for a platform user id; ' +
        'approve_code = owner manually approves a pending code; ' +
        'revoke = disconnect a platform user id from this bot; ' +
        'list = show grants.',
    },
    platform: {
      type: 'string',
      enum: ['telegram', 'discord', 'slack', 'zalo'],
      description: 'Messaging platform. Defaults to telegram.',
    },
    platformUserId: {
      type: 'string',
      description:
        'Target user id on that platform (required for create/revoke).',
    },
    code: {
      type: 'string',
      description: '6-char verification code (required for approve_code).',
    },
  },
  required: ['action'],
};

@RegisterSkill({
  code: 'bot_access_manage',
  name: 'Bot Access Manage',
  description:
    'Manage guest access for your bot (OpenClaw-style allowFrom). ' +
    'Can create verification code for a platform user id, revoke/disconnect that id, or list current access grants. ' +
    'All access-code records are stored only inside current user workspace folder.',
  category: SkillCategory.MESSAGING,
  parametersSchema: PARAMETERS_SCHEMA,
  minModelTier: ModelTier.SKILL,
})
@Injectable()
export class BotAccessManageSkill implements ISkillRunner {
  constructor(
    private readonly botAccessService: BotAccessService,
    private readonly usersService: UsersService,
    private readonly workspaceService: WorkspaceService,
  ) {}

  get definition(): ISkillDefinition {
    return {
      code: 'bot_access_manage',
      name: 'Bot Access Manage',
      description: 'Create/revoke/list bot access grants for your own bot',
      category: SkillCategory.MESSAGING,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
      minModelTier: ModelTier.SKILL,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const action = String(context.parameters.action || '')
      .trim()
      .toLowerCase();
    const platform = this.parsePlatform(context.parameters.platform);
    const platformUserId = String(
      context.parameters.platformUserId || '',
    ).trim();
    const code = String(context.parameters.code || '')
      .trim()
      .toUpperCase();

    const owner = await this.usersService.findById(context.userId);
    if (!owner) {
      return {
        success: false,
        error: 'Owner user not found',
        metadata: { durationMs: Date.now() - start },
      };
    }

    if (!platform) {
      return {
        success: false,
        error: 'Invalid platform. Use telegram|discord|slack|zalo',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const requiresOwnerTelegramMatch = [
      'create',
      'approve_code',
      'revoke',
    ].includes(action);
    if (requiresOwnerTelegramMatch) {
      const ownerTelegramId = (owner.telegramId || '').trim();
      const senderTelegramId = (context.actorTelegramId || '').trim();
      if (!ownerTelegramId) {
        return {
          success: false,
          error:
            'Owner chưa cấu hình users.telegram_id, không thể duyệt thao tác quyền bot.',
          metadata: { durationMs: Date.now() - start },
        };
      }
      if (!senderTelegramId || senderTelegramId !== ownerTelegramId) {
        return {
          success: false,
          error:
            'Chỉ Telegram ID của owner bot mới được phép create/revoke/approve_code.',
          metadata: { durationMs: Date.now() - start },
        };
      }
    }

    if (action === 'create') {
      if (!platformUserId) {
        return {
          success: false,
          error: 'platformUserId is required for create',
          metadata: { durationMs: Date.now() - start },
        };
      }
      const { code, grantId } = await this.botAccessService.createInvite(
        owner.uid,
        platform,
        platformUserId,
      );
      this.appendAudit(owner.identifier, {
        ts: new Date().toISOString(),
        action: 'create',
        platform,
        platformUserId,
        code,
        grantId,
      });
      return {
        success: true,
        data: {
          platform,
          platformUserId,
          verificationCode: code,
          grantId,
          note:
            `Đã tạo mã xác thực cho ${platformUserId}. ` +
            `Mã có hiệu lực 24 giờ, owner cần duyệt thủ công bằng approve_code.`,
        },
        metadata: { durationMs: Date.now() - start },
      };
    }

    if (action === 'approve_code') {
      if (!/^[A-F0-9]{6}$/.test(code)) {
        return {
          success: false,
          error: 'code must be a 6-character hex string (e.g. ABCDEF)',
          metadata: { durationMs: Date.now() - start },
        };
      }

      const approved = await this.botAccessService.approvePendingByCode(
        owner.uid,
        platform,
        code,
      );

      this.appendAudit(owner.identifier, {
        ts: new Date().toISOString(),
        action: 'approve_code',
        platform,
        code,
        approved: approved.approved,
        platformUserId: approved.platformUserId,
      });

      return {
        success: true,
        data: {
          platform,
          code,
          approved: approved.approved,
          reason: approved.reason,
          platformUserId: approved.platformUserId,
          note: approved.approved
            ? `Đã duyệt mã ${code}. User ${approved.platformUserId} có thể dùng bot.`
            : approved.reason === 'expired'
              ? `Mã ${code} đã hết hạn (quá 24 giờ).`
              : approved.reason === 'already_verified'
                ? `Mã ${code} đã được duyệt trước đó.`
                : approved.reason === 'bot_not_configured'
                  ? 'Bot chưa được cấu hình cho owner này.'
                  : `Không tìm thấy mã ${code}.`,
        },
        metadata: { durationMs: Date.now() - start },
      };
    }

    if (action === 'revoke') {
      if (!platformUserId) {
        return {
          success: false,
          error: 'platformUserId is required for revoke',
          metadata: { durationMs: Date.now() - start },
        };
      }
      const revoked = await this.botAccessService.revokeByPlatformUserId(
        owner.uid,
        platform,
        platformUserId,
      );
      this.appendAudit(owner.identifier, {
        ts: new Date().toISOString(),
        action: 'revoke',
        platform,
        platformUserId,
        revoked,
      });
      return {
        success: true,
        data: {
          platform,
          platformUserId,
          revoked,
          note: revoked
            ? `Đã ngắt kết nối quyền của user ${platformUserId}.`
            : `Không tìm thấy grant để thu hồi cho user ${platformUserId}.`,
        },
        metadata: { durationMs: Date.now() - start },
      };
    }

    if (action === 'list') {
      const all = await this.botAccessService.listGrants(owner.uid);
      const grants = all
        .filter((g) => g.platform === platform)
        .map((g) => ({
          id: g.id,
          platform: g.platform,
          platformUserId: g.platformUserId,
          isVerified: g.isVerified,
          createdAt: g.createdAt,
        }));
      return {
        success: true,
        data: { platform, total: grants.length, grants },
        metadata: { durationMs: Date.now() - start },
      };
    }

    return {
      success: false,
      error: 'Unknown action. Use create|approve_code|revoke|list',
      metadata: { durationMs: Date.now() - start },
    };
  }

  private parsePlatform(value: unknown): BotPlatform | null {
    const raw = String(value || 'telegram')
      .toLowerCase()
      .trim();
    if (raw === BotPlatform.TELEGRAM) return BotPlatform.TELEGRAM;
    if (raw === BotPlatform.DISCORD) return BotPlatform.DISCORD;
    if (raw === BotPlatform.SLACK) return BotPlatform.SLACK;
    if (raw === BotPlatform.ZALO) return BotPlatform.ZALO;
    return null;
  }

  private appendAudit(
    identifier: string,
    entry: Record<string, unknown>,
  ): void {
    const workspaceDir = this.workspaceService.getUserWorkspaceDir(identifier);
    const dir = path.join(workspaceDir, 'bot-access');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'access-codes.jsonl');
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  }
}
