import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { BotUser } from '../../modules/bot-users/entities/bot-user.entity';
import { BotDeliveryService } from '../../modules/bot-users/bot-delivery.service';
import { TelegramUpdateProcessorService } from './telegram-update-processor.service';

type TgMode = 'webhook' | 'polling';

@Injectable()
export class TelegramFallbackPollingService implements OnModuleInit {
  private readonly logger = new Logger(TelegramFallbackPollingService.name);
  private readonly modes = new Map<string, TgMode>();
  private readonly offsets = new Map<string, number>();
  private readonly processing = new Set<string>();

  constructor(
    @InjectRepository(BotUser)
    private readonly botUserRepo: Repository<BotUser>,
    private readonly configService: ConfigService,
    private readonly deliveryService: BotDeliveryService,
    private readonly processor: TelegramUpdateProcessorService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Run an initial reconcile immediately so we don't wait for the first
    // Cron tick (which can be up to ~30s), reducing delay after server restart.
    await this.reconcileMode();
  }

  @Cron('*/30 * * * * *')
  async reconcileMode(): Promise<void> {
    const tokens = await this.getTelegramTokens();
    const baseUrl = this.configService
      .get<string>('WEBHOOK_BASE_URL')
      ?.replace(/\/+$/, '');

    for (const token of tokens) {
      const desired = baseUrl ? `${baseUrl}/webhooks/telegram/${token}` : '';
      let webhookHealthy = false;

      if (desired) {
        const info = await this.deliveryService.getTelegramWebhookInfo(token);
        const nowSec = Math.floor(Date.now() / 1000);
        const hasRecentError =
          !!info.result?.last_error_date &&
          nowSec - info.result.last_error_date < 90;
        webhookHealthy =
          info.ok && info.result?.url === desired && !hasRecentError;

        if (!webhookHealthy) {
          const setOk = await this.deliveryService.setTelegramWebhook(
            token,
            desired,
          );
          webhookHealthy = setOk;
        }
      }

      if (webhookHealthy) {
        if (this.modes.get(token) === 'polling') {
          this.logger.log(
            `Telegram token ${token.slice(0, 8)}... switched to WEBHOOK mode`,
          );
        }
        this.modes.set(token, 'webhook');
        continue;
      }

      if (this.modes.get(token) !== 'polling') {
        await this.deliveryService.deleteTelegramWebhook(token, false);
        this.logger.warn(
          `Telegram token ${token.slice(0, 8)}... switched to POLLING fallback mode`,
        );
      }
      this.modes.set(token, 'polling');
    }
  }

  @Cron('*/4 * * * * *')
  async pollFallbackTokens(): Promise<void> {
    const tokens = await this.getTelegramTokens();

    for (const token of tokens) {
      if (this.modes.get(token) !== 'polling') continue;
      if (this.processing.has(token)) continue;

      this.processing.add(token);
      try {
        const offset = this.offsets.get(token);
        const updates = await this.deliveryService.getTelegramUpdates(
          token,
          offset,
          1,
          20,
        );
        for (const upd of updates) {
          try {
            await this.processor.processUpdate(token, upd);
          } catch (err: any) {
            this.logger.error(
              `Polling update process failed (${token.slice(0, 8)}...): ${err?.message ?? err}`,
            );
          } finally {
            if (typeof upd?.update_id === 'number') {
              this.offsets.set(token, upd.update_id + 1);
            }
          }
        }
      } finally {
        this.processing.delete(token);
      }
    }
  }

  private async getTelegramTokens(): Promise<string[]> {
    const bots = await this.botUserRepo.find({
      where: { telegramBotToken: Not(IsNull()) },
      select: ['telegramBotToken'],
    });
    return bots
      .map((b) => (b.telegramBotToken || '').trim())
      .filter((x) => !!x);
  }
}
