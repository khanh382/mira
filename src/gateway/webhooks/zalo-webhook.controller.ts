import { Controller, Post, Body, Logger, HttpCode } from '@nestjs/common';
import { BotAccessService } from '../../modules/bot-users/bot-access.service';
import { BotPlatform } from '../../modules/bot-users/entities/bot-access-grant.entity';
import { GatewayService } from '../gateway.service';
import { ChatPlatform } from '../../modules/chat/entities/chat-thread.entity';

/**
 * Zalo OA Webhook Controller.
 *
 * Access Control tương tự Telegram:
 * - Kiểm tra sender zalo id → owner's zalo_id hoặc grant đã verified.
 */
@Controller('webhooks/zalo')
export class ZaloWebhookController {
  private readonly logger = new Logger(ZaloWebhookController.name);

  constructor(
    private readonly botAccessService: BotAccessService,
    private readonly gatewayService: GatewayService,
  ) {}

  @Post()
  @HttpCode(200)
  async handleEvent(@Body() event: any) {
    const eventName = event?.event_name;

    if (eventName === 'user_send_text') {
      const senderId = event?.sender?.id;
      const content = event?.message?.text;

      if (!senderId || !content) {
        return { ok: true };
      }

      this.logger.debug(`Zalo message from ${senderId}: ${content}`);

      // Verification code check
      if (/^[A-Fa-f0-9]{6}$/.test(content.trim())) {
        // Zalo OA token is typically from app config, not URL param
        // const verified = await this.botAccessService.verifyCode(
        //   zaloOaToken, BotPlatform.ZALO, senderId, content.trim(),
        // );
      }

      // TODO: Resolve bot token from config, then check access
      // const { allowed, ownerUid } = await this.botAccessService.checkAccess(
      //   zaloOaToken, BotPlatform.ZALO, senderId,
      // );
      // if (!allowed) return { ok: true, denied: true };
      //
      // await this.gatewayService.handleMessage(ownerUid, content, {
      //   channelId: 'zalo',
      //   platform: ChatPlatform.ZALO,
      // });
    }

    return { ok: true };
  }
}
