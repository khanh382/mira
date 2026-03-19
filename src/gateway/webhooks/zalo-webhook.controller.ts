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
 * Zalo OA Webhook Controller.
 *
 * Security model (giống Telegram):
 * - botToken trong URL là secret per-user (chỉ Zalo OA và owner biết)
 * - BotAccessService.checkAccess() đối chiếu senderId với owner's zalo_id
 * - bot_access_grants cho phép cấp quyền cho người khác (qua verification code)
 */
@Controller('webhooks/zalo')
export class ZaloWebhookController {
  private readonly logger = new Logger(ZaloWebhookController.name);

  constructor(
    private readonly botAccessService: BotAccessService,
    private readonly gatewayService: GatewayService,
  ) {}

  @Post(':botToken')
  @HttpCode(200)
  async handleEventWithToken(
    @Param('botToken') botToken: string,
    @Body() event: any,
  ) {
    return this.handleCore(botToken, event);
  }

  @Post()
  @HttpCode(200)
  async handleEvent(
    @Body() event: any,
    @Headers() headers: Record<string, string>,
  ) {
    const botToken = this.resolveBotToken(undefined, headers, event);
    return this.handleCore(botToken, event);
  }

  private async handleCore(botToken: string | null, event: any) {
    const eventName = event?.event_name;

    if (eventName !== 'user_send_text') {
      return { ok: true };
    }

    if (!botToken) {
      this.logger.warn('Zalo webhook missing bot token');
      return { ok: true, denied: true };
    }

    const senderId = event?.sender?.id ? String(event.sender.id) : null;
    const content =
      typeof event?.message?.text === 'string'
        ? event.message.text.trim()
        : null;

    if (!senderId || !content) {
      return { ok: true };
    }

    this.logger.debug(`Zalo message from ${senderId}: ${content}`);

    if (/^[A-Fa-f0-9]{6}$/.test(content)) {
      const verified = await this.botAccessService.verifyCode(
        botToken,
        BotPlatform.ZALO,
        senderId,
        content,
      );
      if (verified) {
        return { ok: true, verified: true };
      }
    }

    const { allowed, ownerUid, botUser } =
      await this.botAccessService.checkAccess(
        botToken,
        BotPlatform.ZALO,
        senderId,
      );

    if (!allowed || !ownerUid) {
      this.logger.warn(
        `Access denied for zalo user ${senderId} on bot ${botUser?.id}`,
      );
      return { ok: true, denied: true };
    }

    await this.gatewayService.handleMessage(ownerUid, content, {
      channelId: 'zalo',
      platform: ChatPlatform.ZALO,
    });

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
      headers?.['x-zalo-bot-token'] ||
      headers?.['authorization'];
    if (headerToken?.trim()) {
      return headerToken.replace(/^Bearer\s+/i, '').trim();
    }
    const bodyToken = payload?.botToken || payload?.bot_token;
    if (typeof bodyToken === 'string' && bodyToken.trim()) {
      return bodyToken.trim();
    }
    return null;
  }
}
