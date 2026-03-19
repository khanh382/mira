import { Controller, Post, Body, Param, Logger, HttpCode } from '@nestjs/common';
import { BotAccessService } from '../../modules/bot-users/bot-access.service';
import { BotPlatform } from '../../modules/bot-users/entities/bot-access-grant.entity';
import { UsersService } from '../../modules/users/users.service';
import { GatewayService } from '../gateway.service';
import { ChatPlatform } from '../../modules/chat/entities/chat-thread.entity';

/**
 * Telegram Webhook Controller.
 *
 * Route: POST /webhooks/telegram/:botToken
 * Mỗi bot có URL riêng → hệ thống tìm BotUser từ token.
 *
 * Security model:
 * - botToken trong URL là secret per-user (chỉ Telegram và owner biết)
 * - BotAccessService.checkAccess() đối chiếu senderId với owner's telegram_id
 * - bot_access_grants cho phép cấp quyền thêm cho người khác (qua verification code)
 */
@Controller('webhooks/telegram')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  constructor(
    private readonly botAccessService: BotAccessService,
    private readonly usersService: UsersService,
    private readonly gatewayService: GatewayService,
  ) {}

  @Post(':botToken')
  @HttpCode(200)
  async handleUpdate(
    @Param('botToken') botToken: string,
    @Body() update: any,
  ) {
    const message = update?.message;
    if (!message?.text || !message?.from) {
      return { ok: true };
    }

    const telegramUserId = String(message.from.id);
    const text = message.text.trim();

    this.logger.debug(
      `Telegram update from ${telegramUserId} via bot ${botToken.slice(0, 8)}...`,
    );

    if (/^[A-Fa-f0-9]{6}$/.test(text)) {
      const verified = await this.botAccessService.verifyCode(
        botToken,
        BotPlatform.TELEGRAM,
        telegramUserId,
        text,
      );
      if (verified) {
        return { ok: true, verified: true };
      }
    }

    const { allowed, botUser, ownerUid } = await this.botAccessService.checkAccess(
      botToken,
      BotPlatform.TELEGRAM,
      telegramUserId,
    );

    if (!allowed) {
      this.logger.warn(
        `Access denied for telegram user ${telegramUserId} on bot ${botUser?.id}`,
      );
      return { ok: true, denied: true };
    }

    await this.gatewayService.handleMessage(ownerUid, text, {
      channelId: 'telegram',
      platform: ChatPlatform.TELEGRAM,
    });

    return { ok: true };
  }
}
