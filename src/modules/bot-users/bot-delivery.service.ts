import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SYSTEM_BOT_MENU_ENTRIES } from './bot-platform-menu';
import { sanitizeAssistantOutboundPlainText } from './assistant-outbound-plain-text';

const execFileAsync = promisify(execFile);

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

    const chunks = this.splitMessage(
      sanitizeAssistantOutboundPlainText(text),
      4096,
    );
    for (const chunk of chunks) {
      try {
        // Plain text avoids Markdown parse errors (**, `, unclosed entities).
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          this.logger.error(
            `Telegram sendMessage failed (${res.status}): ${body}`,
          );
          return false;
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
        this.logger.warn(
          `Telegram sendChatAction failed (${res.status}): ${body}`,
        );
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

  /**
   * Menu lệnh khi user gõ "/" trong chat (Telegram BotCommand).
   * @see https://core.telegram.org/bots/api#setmycommands
   */
  async setTelegramBotCommands(botToken: string): Promise<boolean> {
    const url = `https://api.telegram.org/bot${botToken}/setMyCommands`;
    const commands = SYSTEM_BOT_MENU_ENTRIES.map((e) => {
      let desc = e.telegramDescription.trim();
      if (desc.length < 3) desc = `${desc}…`.slice(0, 3);
      if (desc.length > 256) desc = desc.slice(0, 253) + '…';
      return { command: e.command, description: desc };
    });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands }),
      });
      const data = (await res.json()) as { ok?: boolean; description?: string };
      if (data?.ok) {
        this.logger.log(
          `Telegram setMyCommands OK (${commands.length} lệnh) bot=${botToken.slice(0, 8)}…`,
        );
        return true;
      }
      this.logger.warn(
        `Telegram setMyCommands failed: ${JSON.stringify(data)}`,
      );
      return false;
    } catch (err) {
      this.logger.warn(`Telegram setMyCommands error: ${err.message}`);
      return false;
    }
  }

  /** Lấy application id để đăng ký slash commands (Discord). */
  async getDiscordApplicationId(botToken: string): Promise<string | null> {
    try {
      const res = await fetch(
        'https://discord.com/api/v10/oauth2/applications/@me',
        { headers: { Authorization: `Bot ${botToken}` } },
      );
      const data = (await res.json()) as { id?: string; message?: string };
      if (data?.id) return String(data.id);
      this.logger.warn(
        `Discord oauth2/applications/@me: ${JSON.stringify(data)}`,
      );
      return null;
    } catch (err) {
      this.logger.warn(`Discord getApplicationId error: ${err.message}`);
      return null;
    }
  }

  /**
   * Đăng ký slash command toàn cục (PUT — idempotent).
   * @see https://discord.com/developers/docs/interactions/application-commands
   */
  async registerDiscordGlobalSlashCommands(botToken: string): Promise<boolean> {
    const applicationId = await this.getDiscordApplicationId(botToken);
    if (!applicationId) return false;

    const body = SYSTEM_BOT_MENU_ENTRIES.map((e) => ({
      name: e.command,
      description:
        e.discordDescription.length > 100
          ? e.discordDescription.slice(0, 97) + '…'
          : e.discordDescription,
      type: 1,
    }));

    const url = `https://discord.com/api/v10/applications/${applicationId}/commands`;
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${botToken}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text();
        this.logger.warn(
          `Discord PUT commands failed (${res.status}): ${errText}`,
        );
        return false;
      }
      this.logger.log(
        `Discord global slash commands registered (${body.length}) app=${applicationId}`,
      );
      return true;
    } catch (err) {
      this.logger.warn(`Discord registerSlashCommands error: ${err.message}`);
      return false;
    }
  }

  async deleteTelegramWebhook(
    botToken: string,
    dropPendingUpdates = false,
  ): Promise<boolean> {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/deleteWebhook`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ drop_pending_updates: dropPendingUpdates }),
        },
      );
      const data = (await res.json()) as any;
      return !!data?.ok;
    } catch (err) {
      this.logger.warn(`Telegram deleteWebhook error: ${err.message}`);
      return false;
    }
  }

  async getTelegramWebhookInfo(botToken: string): Promise<{
    ok: boolean;
    result?: {
      url?: string;
      has_custom_certificate?: boolean;
      pending_update_count?: number;
      last_error_date?: number;
      last_error_message?: string;
      max_connections?: number;
      ip_address?: string;
    };
  }> {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/getWebhookInfo`,
      );
      const data = (await res.json()) as any;
      return {
        ok: !!data?.ok,
        result: data?.result,
      };
    } catch (err) {
      this.logger.warn(`Telegram getWebhookInfo error: ${err.message}`);
      return { ok: false };
    }
  }

  async getTelegramUpdates(
    botToken: string,
    offset?: number,
    timeoutSec = 1,
    limit = 20,
  ): Promise<any[]> {
    try {
      const params = new URLSearchParams();
      if (offset != null) params.set('offset', String(offset));
      params.set('timeout', String(timeoutSec));
      params.set('limit', String(limit));
      const url = `https://api.telegram.org/bot${botToken}/getUpdates?${params.toString()}`;
      const res = await fetch(url);
      const data = (await res.json()) as any;
      if (!data?.ok || !Array.isArray(data?.result)) {
        return [];
      }
      return data.result;
    } catch (err) {
      this.logger.warn(`Telegram getUpdates error: ${err.message}`);
      return [];
    }
  }

  /**
   * Telegram getFile — lấy `file_path` để tải binary.
   * @see https://core.telegram.org/bots/api#getfile
   */
  async getTelegramFileMeta(
    botToken: string,
    fileId: string,
  ): Promise<{ filePath: string; fileSize?: number }> {
    const url = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      ok?: boolean;
      description?: string;
      result?: { file_path?: string; file_size?: number };
    };
    if (!data?.ok || !data.result?.file_path) {
      throw new Error(data?.description || 'Telegram getFile failed');
    }
    return {
      filePath: data.result.file_path,
      fileSize: data.result.file_size,
    };
  }

  /**
   * Tải file Telegram về đĩa (đường dẫn tuyệt đối).
   */
  async downloadTelegramFile(
    botToken: string,
    fileId: string,
    destAbsolutePath: string,
    maxBytes = 48 * 1024 * 1024,
  ): Promise<{ bytes: number }> {
    const { filePath, fileSize } = await this.getTelegramFileMeta(
      botToken,
      fileId,
    );
    if (fileSize != null && fileSize > maxBytes) {
      throw new Error(`File too large (${fileSize} bytes, max ${maxBytes})`);
    }
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    fs.mkdirSync(path.dirname(destAbsolutePath), { recursive: true });

    try {
      const res = await fetch(fileUrl);
      if (!res.ok) {
        throw new Error(`Telegram file download failed: HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) {
        throw new Error(`Downloaded file too large (${buf.length} bytes)`);
      }
      fs.writeFileSync(destAbsolutePath, buf);
      return { bytes: buf.length };
    } catch (error: any) {
      this.logger.warn(
        `Telegram fetch download failed, fallback to curl: ${error?.message ?? error}`,
      );
      return this.downloadTelegramFileWithCurl(
        fileUrl,
        destAbsolutePath,
        maxBytes,
      );
    }
  }

  private async downloadTelegramFileWithCurl(
    fileUrl: string,
    destAbsolutePath: string,
    maxBytes: number,
  ): Promise<{ bytes: number }> {
    try {
      await execFileAsync('curl', [
        '--fail',
        '--silent',
        '--show-error',
        '--location',
        '--max-time',
        '60',
        '--output',
        destAbsolutePath,
        fileUrl,
      ]);
      const stat = fs.statSync(destAbsolutePath);
      if (stat.size > maxBytes) {
        fs.unlinkSync(destAbsolutePath);
        throw new Error(`Downloaded file too large (${stat.size} bytes)`);
      }
      return { bytes: stat.size };
    } catch (error: any) {
      throw new Error(
        `Telegram file download failed (fetch + curl): ${error?.message ?? error}`,
      );
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

    const chunks = this.splitMessage(
      sanitizeAssistantOutboundPlainText(text),
      2000,
    );
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

    const chunks = this.splitMessage(
      sanitizeAssistantOutboundPlainText(text),
      2000,
    );
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
          this.logger.error(
            `Discord channel msg failed (${res.status}): ${body}`,
          );
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
    quickReplies?: Array<{ title: string; payload: string }>,
  ): Promise<boolean> {
    const url = 'https://openapi.zalo.me/v3.0/oa/message/cs';

    const chunks = this.splitMessage(
      sanitizeAssistantOutboundPlainText(text),
      2000,
    );
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isLast = i === chunks.length - 1;
      const message: Record<string, unknown> = { text: chunk };
      if (isLast && quickReplies?.length) {
        message.quick_replies = quickReplies.map((q) => ({
          content_type: 'text',
          title: q.title.slice(0, 30),
          payload: q.payload.slice(0, 200),
        }));
      }
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            access_token: accessToken,
          },
          body: JSON.stringify({
            recipient: { user_id: recipientUserId },
            message,
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
