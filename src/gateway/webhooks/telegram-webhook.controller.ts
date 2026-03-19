import { Controller, Post, Body, Param, Logger, HttpCode } from '@nestjs/common';
import { BotAccessService } from '../../modules/bot-users/bot-access.service';
import { BotDeliveryService } from '../../modules/bot-users/bot-delivery.service';
import { BotPlatform } from '../../modules/bot-users/entities/bot-access-grant.entity';
import { UsersService } from '../../modules/users/users.service';
import { GatewayService } from '../gateway.service';
import { ChatPlatform } from '../../modules/chat/entities/chat-thread.entity';

@Controller('webhooks/telegram')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  constructor(
    private readonly botAccessService: BotAccessService,
    private readonly usersService: UsersService,
    private readonly gatewayService: GatewayService,
    private readonly deliveryService: BotDeliveryService,
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
    const chatId = message.chat.id;
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
        await this.deliveryService.sendTelegram(
          botToken,
          chatId,
          '✅ Xác thực thành công! Bạn đã được cấp quyền truy cập bot.',
        );
        return { ok: true, verified: true };
      }
    }

    const { allowed, botUser, ownerUid } =
      await this.botAccessService.checkAccess(
        botToken,
        BotPlatform.TELEGRAM,
        telegramUserId,
      );

    if (!allowed) {
      this.logger.warn(
        `Access denied for telegram user ${telegramUserId} on bot ${botUser?.id}`,
      );
      await this.deliveryService.sendTelegram(
        botToken,
        chatId,
        '⛔ Bạn chưa được cấp quyền dùng bot này. Hãy nhắn mã xác thực 6 ký tự do owner cấp.',
      );
      return { ok: true, denied: true };
    }

    const stopTyping = this.deliveryService.startTelegramTypingLoop(botToken, chatId);
    try {
      const result = await this.gatewayService.handleMessage(ownerUid, text, {
        channelId: 'telegram',
        platform: ChatPlatform.TELEGRAM,
      });

      if (result.response) {
        await this.deliveryService.sendTelegram(botToken, chatId, result.response);
      }
    } finally {
      stopTyping();
    }

    return { ok: true };
  }
}
