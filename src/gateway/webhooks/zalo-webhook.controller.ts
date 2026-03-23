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
import { BotDeliveryService } from '../../modules/bot-users/bot-delivery.service';
import { BotPlatform } from '../../modules/bot-users/entities/bot-access-grant.entity';
import { GatewayService } from '../gateway.service';
import { ChatPlatform } from '../../modules/chat/entities/chat-thread.entity';
import { ZALO_QUICK_MENU_BUTTONS } from '../../modules/bot-users/bot-platform-menu';

@Controller('webhooks/zalo')
export class ZaloWebhookController {
  private readonly logger = new Logger(ZaloWebhookController.name);

  constructor(
    private readonly botAccessService: BotAccessService,
    private readonly gatewayService: GatewayService,
    private readonly deliveryService: BotDeliveryService,
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
        await this.deliveryService.sendZalo(
          botToken,
          senderId,
          '✅ Xác thực thành công! Bạn đã được cấp quyền truy cập bot.',
        );
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
      const invite =
        await this.botAccessService.getOrCreatePendingInviteByBotToken(
          botToken,
          BotPlatform.ZALO,
          senderId,
        );
      if (invite?.code) {
        await this.deliveryService.sendZalo(
          botToken,
          senderId,
          `⛔️ Bạn chưa được cấp quyền dùng bot này. Mã xác thực của bạn là ${invite.code} (hết hạn sau 24 giờ). Hãy gửi mã này cho owner để owner duyệt kích hoạt bot nhé`,
        );
      } else {
        await this.deliveryService.sendZalo(
          botToken,
          senderId,
          '⛔️ Bạn chưa được cấp quyền dùng bot này. Hãy nhắn mã xác thực 6 ký tự do owner cấp.',
        );
      }
      return { ok: true, denied: true };
    }

    const dedupId =
      event?.event_id ??
      event?.eventId ??
      event?.id ??
      event?.message?.id ??
      event?.message?.message_id;

    const menuTrigger =
      /^(menu|lenh|help|\/menu)$/i.test(content) ||
      /^lệnh$/i.test(content.trim());
    if (menuTrigger) {
      const menuResult = await this.gatewayService.handleMessage(
        ownerUid,
        '/menu',
        {
          channelId: 'zalo',
          platform: ChatPlatform.ZALO,
          dedupId: dedupId ? String(dedupId) : undefined,
          zaloUserId: senderId ?? undefined,
        },
      );
      if (menuResult.response) {
        await this.deliveryService.sendZalo(
          botToken,
          senderId,
          menuResult.response,
          [...ZALO_QUICK_MENU_BUTTONS],
        );
      }
      return { ok: true, menu: true };
    }

    const result = await this.gatewayService.handleMessage(ownerUid, content, {
      channelId: 'zalo',
      platform: ChatPlatform.ZALO,
      dedupId: dedupId ? String(dedupId) : undefined,
      zaloUserId: senderId ?? undefined,
    });

    if (result.response) {
      await this.deliveryService.sendZalo(botToken, senderId, result.response);
    }

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
