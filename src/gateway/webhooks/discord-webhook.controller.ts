import { Controller, Post, Body, Logger, HttpCode } from '@nestjs/common';
import { BotAccessService } from '../../modules/bot-users/bot-access.service';
import { BotPlatform } from '../../modules/bot-users/entities/bot-access-grant.entity';
import { GatewayService } from '../gateway.service';
import { ChatPlatform } from '../../modules/chat/entities/chat-thread.entity';

/**
 * Discord Interaction Endpoint.
 *
 * Access Control tương tự Telegram:
 * - Kiểm tra discord user id → owner's discord_id hoặc grant đã verified.
 */
@Controller('webhooks/discord')
export class DiscordWebhookController {
  private readonly logger = new Logger(DiscordWebhookController.name);

  constructor(
    private readonly botAccessService: BotAccessService,
    private readonly gatewayService: GatewayService,
  ) {}

  @Post()
  @HttpCode(200)
  async handleInteraction(@Body() interaction: any) {
    if (interaction?.type === 1) {
      return { type: 1 };
    }

    // TODO: Extract discord user id, bot token, message content
    // from the interaction payload and apply access control:
    //
    // const discordUserId = interaction?.member?.user?.id;
    // const content = interaction?.data?.options?.[0]?.value;
    // const botToken = ... (from config or header)
    //
    // const { allowed, ownerUid } = await this.botAccessService.checkAccess(
    //   botToken, BotPlatform.DISCORD, discordUserId,
    // );
    // if (!allowed) return { ok: true, denied: true };
    //
    // await this.gatewayService.handleMessage(ownerUid, content, {
    //   channelId: 'discord',
    //   platform: ChatPlatform.DISCORD,
    // });

    this.logger.debug(`Discord interaction: type=${interaction?.type}`);
    return { ok: true };
  }
}
