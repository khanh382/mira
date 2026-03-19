import {
  Controller,
  Post,
  Body,
  Logger,
  HttpCode,
  Param,
  Headers,
} from '@nestjs/common';
import { BotAccessService } from '../../modules/bot-users/bot-access.service';
import { BotPlatform } from '../../modules/bot-users/entities/bot-access-grant.entity';
import { GatewayService } from '../gateway.service';
import { ChatPlatform } from '../../modules/chat/entities/chat-thread.entity';

/**
 * Discord Interaction Endpoint.
 *
 * Security model (giống Telegram):
 * - botToken trong URL là secret per-user (chỉ Discord và owner biết)
 * - BotAccessService.checkAccess() đối chiếu senderId với owner's discord_id
 * - bot_access_grants cho phép cấp quyền cho người khác (qua verification code)
 */
@Controller('webhooks/discord')
export class DiscordWebhookController {
  private readonly logger = new Logger(DiscordWebhookController.name);

  constructor(
    private readonly botAccessService: BotAccessService,
    private readonly gatewayService: GatewayService,
  ) {}

  @Post(':botToken')
  @HttpCode(200)
  async handleInteractionWithToken(
    @Param('botToken') botToken: string,
    @Body() interaction: any,
  ) {
    return this.handleCore(botToken, interaction);
  }

  @Post()
  @HttpCode(200)
  async handleInteraction(
    @Body() interaction: any,
    @Headers() headers: Record<string, string>,
  ) {
    const botToken = this.resolveBotToken(undefined, headers, interaction);
    return this.handleCore(botToken, interaction);
  }

  private async handleCore(botToken: string | null, interaction: any) {
    // Discord PING verification (type 1) — required for Discord to accept the endpoint
    if (interaction?.type === 1) {
      return { type: 1 };
    }

    if (!botToken) {
      this.logger.warn('Discord webhook missing bot token');
      return { ok: true, denied: true };
    }

    const discordUserId = this.extractDiscordUserId(interaction);
    const content = this.extractContent(interaction);

    if (!discordUserId || !content) {
      this.logger.debug(
        `Discord interaction ignored: missing sender/content (type=${interaction?.type})`,
      );
      return { ok: true };
    }

    if (/^[A-Fa-f0-9]{6}$/.test(content.trim())) {
      const verified = await this.botAccessService.verifyCode(
        botToken,
        BotPlatform.DISCORD,
        discordUserId,
        content.trim(),
      );
      if (verified) {
        return { ok: true, verified: true };
      }
    }

    const { allowed, ownerUid, botUser } =
      await this.botAccessService.checkAccess(
        botToken,
        BotPlatform.DISCORD,
        discordUserId,
      );

    if (!allowed || !ownerUid) {
      this.logger.warn(
        `Access denied for discord user ${discordUserId} on bot ${botUser?.id}`,
      );
      return { ok: true, denied: true };
    }

    await this.gatewayService.handleMessage(ownerUid, content, {
      channelId: 'discord',
      platform: ChatPlatform.DISCORD,
    });

    this.logger.debug(
      `Discord interaction routed: user=${discordUserId}, owner=${ownerUid}`,
    );
    return { ok: true };
  }

  private resolveBotToken(
    pathToken: string | undefined,
    headers: Record<string, string>,
    payload: any,
  ): string | null {
    if (pathToken?.trim()) return pathToken.trim();
    const headerToken =
      headers?.['x-bot-token'] ||
      headers?.['x-discord-bot-token'] ||
      headers?.['authorization'];
    if (headerToken?.trim()) {
      return headerToken.replace(/^Bot\s+/i, '').trim();
    }
    const bodyToken = payload?.botToken || payload?.bot_token;
    if (typeof bodyToken === 'string' && bodyToken.trim()) {
      return bodyToken.trim();
    }
    return null;
  }

  private extractDiscordUserId(payload: any): string | null {
    const raw =
      payload?.member?.user?.id ||
      payload?.user?.id ||
      payload?.author?.id ||
      payload?.d?.author?.id;
    return raw ? String(raw) : null;
  }

  private extractContent(payload: any): string | null {
    const optionValue = this.findFirstStringOption(payload?.data?.options);
    if (optionValue) return optionValue;

    const dataName = payload?.data?.name;
    if (typeof dataName === 'string' && dataName.trim()) {
      return dataName.trim();
    }

    const text = payload?.content || payload?.d?.content;
    if (typeof text === 'string' && text.trim()) {
      return text.trim();
    }

    return null;
  }

  private findFirstStringOption(options: any[]): string | null {
    if (!Array.isArray(options)) return null;
    for (const opt of options) {
      if (typeof opt?.value === 'string' && opt.value.trim()) {
        return opt.value.trim();
      }
      const nested = this.findFirstStringOption(opt?.options);
      if (nested) return nested;
    }
    return null;
  }
}
