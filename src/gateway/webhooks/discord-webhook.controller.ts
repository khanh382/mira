import {
  Controller,
  Post,
  Body,
  Logger,
  HttpCode,
  Param,
  Headers,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { BotAccessService } from '../../modules/bot-users/bot-access.service';
import { BotDeliveryService } from '../../modules/bot-users/bot-delivery.service';
import { BotPlatform } from '../../modules/bot-users/entities/bot-access-grant.entity';
import { GatewayService } from '../gateway.service';
import { ChatPlatform } from '../../modules/chat/entities/chat-thread.entity';

@Controller('webhooks/discord')
export class DiscordWebhookController {
  private readonly logger = new Logger(DiscordWebhookController.name);

  constructor(
    private readonly botAccessService: BotAccessService,
    private readonly gatewayService: GatewayService,
    private readonly deliveryService: BotDeliveryService,
    private readonly configService: ConfigService,
  ) {}

  @Post(':botToken')
  @HttpCode(200)
  async handleInteractionWithToken(
    @Param('botToken') botToken: string,
    @Body() interaction: any,
    @Res() res: Response,
  ) {
    return this.handleCore(botToken, interaction, res);
  }

  @Post()
  @HttpCode(200)
  async handleInteraction(
    @Body() interaction: any,
    @Headers() headers: Record<string, string>,
    @Res() res: Response,
  ) {
    const botToken = this.resolveBotToken(undefined, headers, interaction);
    return this.handleCore(botToken, interaction, res);
  }

  private async handleCore(
    botToken: string | null,
    interaction: any,
    res: Response,
  ) {
    if (interaction?.type === 1) {
      return res.json({ type: 1 });
    }

    if (!botToken) {
      this.logger.warn('Discord webhook missing bot token');
      return res.json({ ok: true, denied: true });
    }

    const discordUserId = this.extractDiscordUserId(interaction);
    const content = this.extractContent(interaction);

    if (!discordUserId || !content) {
      this.logger.debug(
        `Discord interaction ignored: missing sender/content (type=${interaction?.type})`,
      );
      return res.json({ ok: true });
    }

    if (/^[A-Fa-f0-9]{6}$/.test(content.trim())) {
      const verified = await this.botAccessService.verifyCode(
        botToken,
        BotPlatform.DISCORD,
        discordUserId,
        content.trim(),
      );
      if (verified) {
        return res.json({
          type: 4,
          data: {
            content:
              '✅ Xác thực thành công! Bạn đã được cấp quyền truy cập bot.',
          },
        });
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
      const invite =
        await this.botAccessService.getOrCreatePendingInviteByBotToken(
          botToken,
          BotPlatform.DISCORD,
          discordUserId,
        );
      const deniedText = invite?.code
        ? `⛔️ Bạn chưa được cấp quyền dùng bot này. Mã xác thực của bạn là ${invite.code} (hết hạn sau 24 giờ). Hãy gửi mã này cho owner để owner duyệt kích hoạt bot nhé`
        : '⛔️ Bạn chưa được cấp quyền dùng bot này. Hãy nhắn mã xác thực 6 ký tự do owner cấp.';
      return res.json({
        type: 4,
        data: { content: deniedText },
      });
    }

    const interactionId = interaction?.id;
    const interactionToken = interaction?.token;
    const applicationId =
      interaction?.application_id ||
      this.configService.get<string>('DISCORD_APPLICATION_ID');

    if (interactionToken && applicationId) {
      res.json({ type: 5 });

      try {
        const result = await this.gatewayService.handleMessage(
          ownerUid,
          content,
          {
            channelId: 'discord',
            platform: ChatPlatform.DISCORD,
            dedupId: interactionId ? String(interactionId) : undefined,
            discordUserId: discordUserId ? String(discordUserId) : undefined,
          },
        );

        if (result.response) {
          await this.deliveryService.sendDiscordFollowup(
            applicationId,
            interactionToken,
            result.response,
          );
        }
      } catch (err) {
        this.logger.error(`Discord pipeline error: ${err.message}`);
        await this.deliveryService.sendDiscordFollowup(
          applicationId,
          interactionToken,
          '❌ Đã xảy ra lỗi khi xử lý yêu cầu.',
        );
      }
    } else {
      const channelId = interaction?.channel_id || interaction?.channel?.id;
      const stopTyping = channelId
        ? this.deliveryService.startDiscordTypingLoop(botToken, channelId)
        : () => {};

      try {
        const result = await this.gatewayService.handleMessage(
          ownerUid,
          content,
          {
            channelId: 'discord',
            platform: ChatPlatform.DISCORD,
            dedupId: interactionId ? String(interactionId) : undefined,
            discordUserId: discordUserId ? String(discordUserId) : undefined,
          },
        );

        if (result.response && channelId) {
          await this.deliveryService.sendDiscordChannel(
            botToken,
            channelId,
            result.response,
          );
        }
      } finally {
        stopTyping();
      }

      return res.json({ ok: true });
    }
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
    // Slash command (APPLICATION_COMMAND): map → /name … để gateway command-first khớp.
    if (Number(payload?.type) === 2 && payload?.data?.name) {
      const name = String(payload.data.name).trim();
      const opts = payload.data.options;
      if (Array.isArray(opts) && opts.length) {
        const parts: string[] = [];
        for (const o of opts) {
          if (o?.value != null && String(o.value).trim() !== '') {
            parts.push(String(o.value).trim());
          }
        }
        if (parts.length) {
          return `/${name} ${parts.join(' ')}`;
        }
      }
      return `/${name}`;
    }

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
