import { Injectable, Logger } from '@nestjs/common';

/**
 * BotDeliveryService — gửi tin nhắn trả lời qua API của từng platform.
 *
 * Mỗi method tương ứng 1 platform, nhận bot token + target + nội dung.
 * Dùng native fetch (Node 18+), không cần thêm dependency.
 */
@Injectable()
export class BotDeliveryService {
  private readonly logger = new Logger(BotDeliveryService.name);

  // ─── Telegram ─────────────────────────────────────────────────────

  async sendTelegram(
    botToken: string,
    chatId: string | number,
    text: string,
  ): Promise<boolean> {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    const chunks = this.splitMessage(text, 4096);
    for (const chunk of chunks) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
            parse_mode: 'Markdown',
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          this.logger.error(`Telegram sendMessage failed (${res.status}): ${body}`);

          if (body.includes("can't parse entities")) {
            await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: chunk }),
            });
          } else {
            return false;
          }
        }
      } catch (err) {
        this.logger.error(`Telegram sendMessage error: ${err.message}`);
        return false;
      }
    }
    return true;
  }

  async sendTelegramTyping(
    botToken: string,
    chatId: string | number,
  ): Promise<boolean> {
    const url = `https://api.telegram.org/bot${botToken}/sendChatAction`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          action: 'typing',
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        this.logger.warn(`Telegram sendChatAction failed (${res.status}): ${body}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`Telegram sendChatAction error: ${err.message}`);
      return false;
    }
  }

  startTelegramTypingLoop(
    botToken: string,
    chatId: string | number,
    intervalMs = 4000,
  ): () => void {
    let active = true;
    let timer: NodeJS.Timeout | null = null;

    const tick = async () => {
      if (!active) return;
      await this.sendTelegramTyping(botToken, chatId);
    };

    // Send immediately, then keep refreshing "typing..."
    void tick();
    timer = setInterval(() => {
      void tick();
    }, intervalMs);

    return () => {
      active = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }

  async setTelegramWebhook(
    botToken: string,
    webhookUrl: string,
  ): Promise<boolean> {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/setWebhook`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: webhookUrl }),
        },
      );
      const data = (await res.json()) as any;
      if (data?.ok) {
        this.logger.log(`Telegram webhook set: ${webhookUrl}`);
        return true;
      }
      this.logger.error(`Telegram setWebhook failed: ${JSON.stringify(data)}`);
      return false;
    } catch (err) {
      this.logger.error(`Telegram setWebhook error: ${err.message}`);
      return false;
    }
  }

  // ─── Discord ──────────────────────────────────────────────────────

  /**
   * Discord interaction deferred response.
   * Gọi ngay trong controller để Discord không timeout (3s).
   */
  deferredInteractionResponse(): Record<string, any> {
    return { type: 5 };
  }

  /**
   * Discord followup message — gửi sau khi pipeline xử lý xong.
   * Dùng interaction webhook endpoint.
   */
  async sendDiscordFollowup(
    applicationId: string,
    interactionToken: string,
    text: string,
  ): Promise<boolean> {
    const url = `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}`;

    const chunks = this.splitMessage(text, 2000);
    for (const chunk of chunks) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: chunk }),
        });
        if (!res.ok) {
          const body = await res.text();
          this.logger.error(`Discord followup failed (${res.status}): ${body}`);
          return false;
        }
      } catch (err) {
        this.logger.error(`Discord followup error: ${err.message}`);
        return false;
      }
    }
    return true;
  }

  /**
   * Discord channel message — gửi trực tiếp vào channel (dùng bot token).
   * Fallback khi không có interaction context.
   */
  async sendDiscordChannel(
    botToken: string,
    channelId: string,
    text: string,
  ): Promise<boolean> {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;

    const chunks = this.splitMessage(text, 2000);
    for (const chunk of chunks) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bot ${botToken}`,
          },
          body: JSON.stringify({ content: chunk }),
        });
        if (!res.ok) {
          const body = await res.text();
          this.logger.error(`Discord channel msg failed (${res.status}): ${body}`);
          return false;
        }
      } catch (err) {
        this.logger.error(`Discord channel msg error: ${err.message}`);
        return false;
      }
    }
    return true;
  }

  async sendDiscordTyping(
    botToken: string,
    channelId: string,
  ): Promise<boolean> {
    const url = `https://discord.com/api/v10/channels/${channelId}/typing`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${botToken}`,
        },
      });
      if (!res.ok) {
        const body = await res.text();
        this.logger.warn(`Discord typing failed (${res.status}): ${body}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`Discord typing error: ${err.message}`);
      return false;
    }
  }

  startDiscordTypingLoop(
    botToken: string,
    channelId: string,
    intervalMs = 7000,
  ): () => void {
    let active = true;
    let timer: NodeJS.Timeout | null = null;

    const tick = async () => {
      if (!active) return;
      await this.sendDiscordTyping(botToken, channelId);
    };

    // Trigger right away, then refresh typing state
    void tick();
    timer = setInterval(() => {
      void tick();
    }, intervalMs);

    return () => {
      active = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }

  // ─── Zalo ─────────────────────────────────────────────────────────

  async sendZalo(
    accessToken: string,
    recipientUserId: string,
    text: string,
  ): Promise<boolean> {
    const url = 'https://openapi.zalo.me/v3.0/oa/message/cs';

    const chunks = this.splitMessage(text, 2000);
    for (const chunk of chunks) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            access_token: accessToken,
          },
          body: JSON.stringify({
            recipient: { user_id: recipientUserId },
            message: { text: chunk },
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          this.logger.error(`Zalo sendMessage failed (${res.status}): ${body}`);
          return false;
        }
      } catch (err) {
        this.logger.error(`Zalo sendMessage error: ${err.message}`);
        return false;
      }
    }
    return true;
  }

  // ─── Utils ────────────────────────────────────────────────────────

  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt < maxLength * 0.3) {
        splitAt = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitAt < maxLength * 0.3) {
        splitAt = maxLength;
      }
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }
}
