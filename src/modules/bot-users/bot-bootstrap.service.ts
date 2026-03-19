import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { BotUser } from './entities/bot-user.entity';
import { BotDeliveryService } from './bot-delivery.service';

/**
 * BotBootstrapService — khởi động & hot-reload bot tokens.
 *
 * 1. Startup: load tất cả bot_users có token → đăng ký webhook tương ứng
 * 2. Hot-reload: mỗi 60s quét DB, phát hiện token mới/thay đổi → re-register
 * 3. Không cần restart server khi user thêm/đổi bot
 */
@Injectable()
export class BotBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(BotBootstrapService.name);

  private readonly registeredWebhooks = new Map<string, string>();

  constructor(
    @InjectRepository(BotUser)
    private readonly botUserRepo: Repository<BotUser>,
    private readonly configService: ConfigService,
    private readonly deliveryService: BotDeliveryService,
  ) {}

  async onModuleInit() {
    await this.syncAllBots();
  }

  /**
   * Hot-reload: quét DB mỗi 60s, đăng ký webhook cho token mới/thay đổi.
   */
  @Cron('0 */5 * * * *')
  async hotReloadBots() {
    await this.syncAllBots();
  }

  private async syncAllBots(): Promise<void> {
    const baseUrl = this.configService.get<string>('WEBHOOK_BASE_URL');
    if (!baseUrl) {
      if (this.registeredWebhooks.size === 0) {
        this.logger.warn(
          'WEBHOOK_BASE_URL not set — bot webhook registration skipped. ' +
          'Set it to your public URL (e.g. https://yourdomain.com) to enable auto-registration.',
        );
      }
      return;
    }

    const normalizedBase = baseUrl.replace(/\/+$/, '');

    try {
      const botUsers = await this.botUserRepo.find({
        where: [
          { telegramBotToken: Not(IsNull()) },
          { discordBotToken: Not(IsNull()) },
          { zaloBotToken: Not(IsNull()) },
        ],
      });

      let registered = 0;
      let skipped = 0;

      for (const bot of botUsers) {
        if (bot.telegramBotToken) {
          const changed = await this.syncTelegramWebhook(
            bot.telegramBotToken,
            normalizedBase,
          );
          if (changed) registered++;
          else skipped++;
        }

        if (bot.discordBotToken) {
          this.ensureDiscordRegistered(bot.discordBotToken, normalizedBase);
          skipped++;
        }

        if (bot.zaloBotToken) {
          this.ensureZaloRegistered(bot.zaloBotToken, normalizedBase);
          skipped++;
        }
      }

      if (registered > 0) {
        this.logger.log(`Bot sync: ${registered} webhooks registered, ${skipped} unchanged`);
      }
    } catch (err) {
      this.logger.error(`Bot sync failed: ${err.message}`);
    }
  }

  private async syncTelegramWebhook(
    botToken: string,
    baseUrl: string,
  ): Promise<boolean> {
    const webhookUrl = `${baseUrl}/webhooks/telegram/${botToken}`;
    const cacheKey = `tg:${botToken}`;

    if (this.registeredWebhooks.get(cacheKey) === webhookUrl) {
      return false;
    }

    const ok = await this.deliveryService.setTelegramWebhook(
      botToken,
      webhookUrl,
    );
    if (ok) {
      this.registeredWebhooks.set(cacheKey, webhookUrl);
      this.logger.log(
        `Telegram webhook registered: ${botToken.slice(0, 8)}... → ${webhookUrl}`,
      );
    }
    return ok;
  }

  private ensureDiscordRegistered(botToken: string, baseUrl: string): void {
    const cacheKey = `dc:${botToken}`;
    if (this.registeredWebhooks.has(cacheKey)) return;

    const url = `${baseUrl}/webhooks/discord/${botToken}`;
    this.registeredWebhooks.set(cacheKey, url);
    this.logger.log(
      `Discord interaction endpoint: ${url} ` +
      `(set this URL in Discord Developer Portal → Interactions Endpoint URL)`,
    );
  }

  private ensureZaloRegistered(botToken: string, baseUrl: string): void {
    const cacheKey = `zl:${botToken}`;
    if (this.registeredWebhooks.has(cacheKey)) return;

    const url = `${baseUrl}/webhooks/zalo/${botToken}`;
    this.registeredWebhooks.set(cacheKey, url);
    this.logger.log(
      `Zalo OA webhook endpoint: ${url} ` +
      `(set this URL in Zalo OA Admin → Webhook settings)`,
    );
  }
}
