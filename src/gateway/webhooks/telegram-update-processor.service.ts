import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { BotAccessService } from '../../modules/bot-users/bot-access.service';
import { BotDeliveryService } from '../../modules/bot-users/bot-delivery.service';
import { BotPlatform } from '../../modules/bot-users/entities/bot-access-grant.entity';
import { BotUsersService } from '../../modules/bot-users/bot-users.service';
import { UsersService } from '../../modules/users/users.service';
import { GatewayService } from '../gateway.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { ChatPlatform } from '../../modules/chat/entities/chat-thread.entity';

function safeBasename(name: string | undefined, fallback: string): string {
  const base = path
    .basename(name || fallback || 'file')
    .replace(/[^\w.\-()+]/g, '_');
  return base.slice(0, 180) || fallback;
}

function pickTelegramAttachment(msg: any): {
  fileId: string;
  suggestedName: string;
} | null {
  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      suggestedName: safeBasename(msg.document.file_name, 'document'),
    };
  }
  if (msg.video) {
    return {
      fileId: msg.video.file_id,
      suggestedName: safeBasename(msg.video.file_name, 'video.mp4'),
    };
  }
  if (msg.video_note) {
    return { fileId: msg.video_note.file_id, suggestedName: 'video_note.mp4' };
  }
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    return { fileId: largest.file_id, suggestedName: 'photo.jpg' };
  }
  if (msg.voice) {
    return { fileId: msg.voice.file_id, suggestedName: 'voice.ogg' };
  }
  if (msg.audio) {
    return {
      fileId: msg.audio.file_id,
      suggestedName: safeBasename(msg.audio.file_name, 'audio'),
    };
  }
  if (msg.animation) {
    return {
      fileId: msg.animation.file_id,
      suggestedName: safeBasename(msg.animation.file_name, 'animation.mp4'),
    };
  }
  return null;
}

interface MediaGroupQueuedItem {
  botToken: string;
  chatId: number;
  ownerUid: number;
  ownerIdentifier: string;
  telegramUserId: string;
  updateId: number;
  messageId: number;
  textPart: string;
  attachment: { fileId: string; suggestedName: string } | null;
}

@Injectable()
export class TelegramUpdateProcessorService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramUpdateProcessorService.name);

  /** Gộp các update cùng `media_group_id` (album) trước khi gọi gateway một lần. */
  private readonly mediaGroupBuffers = new Map<string, MediaGroupQueuedItem[]>();
  private readonly mediaGroupTimers = new Map<string, NodeJS.Timeout>();
  /** Đủ lâu để Telegram gửi hết các ảnh trong album trước khi flush (tránh 2 lần gọi gateway). */
  private readonly mediaGroupDebounceMs = 1200;

  /**
   * De-dup for Telegram webhook/polling retries.
   * Telegram can deliver the same update multiple times (especially when switching
   * between webhook and polling). Without this, the agent may re-process old
   * messages and loop.
   */
  private readonly recentUpdateKeys = new Map<string, number>(); // key -> firstSeenAtMs
  private readonly recentUpdateTtlMs = 5 * 60 * 1000; // 5 minutes
  private readonly recentUpdateMaxSize = 3000;

  private isDuplicateUpdate(botToken: string, update: any): boolean {
    const updateId = update?.update_id;
    if (typeof updateId !== 'number') return false;
    const key = `${botToken}:${updateId}`;
    const now = Date.now();
    const prev = this.recentUpdateKeys.get(key);
    if (typeof prev === 'number' && now - prev <= this.recentUpdateTtlMs) {
      return true;
    }

    this.recentUpdateKeys.set(key, now);

    // Simple cleanup (avoid unbounded memory).
    if (this.recentUpdateKeys.size > this.recentUpdateMaxSize) {
      const sorted = [...this.recentUpdateKeys.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of sorted.slice(0, 500)) {
        this.recentUpdateKeys.delete(k);
      }
    }

    return false;
  }

  constructor(
    private readonly botAccessService: BotAccessService,
    private readonly botUsersService: BotUsersService,
    private readonly usersService: UsersService,
    private readonly gatewayService: GatewayService,
    private readonly deliveryService: BotDeliveryService,
    private readonly workspaceService: WorkspaceService,
  ) {}

  onModuleDestroy(): void {
    for (const t of this.mediaGroupTimers.values()) {
      clearTimeout(t);
    }
    this.mediaGroupTimers.clear();
    this.mediaGroupBuffers.clear();
  }

  private scheduleMediaGroupFlush(key: string): void {
    const existing = this.mediaGroupTimers.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      void this.flushMediaGroup(key).catch((err: unknown) => {
        this.logger.error(
          `flushMediaGroup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.mediaGroupDebounceMs);
    this.mediaGroupTimers.set(key, t);
  }

  private async flushMediaGroup(key: string): Promise<void> {
    this.mediaGroupTimers.delete(key);
    const items = this.mediaGroupBuffers.get(key);
    this.mediaGroupBuffers.delete(key);
    if (!items?.length) return;

    items.sort((a, b) => a.messageId - b.messageId);

    const first = items[0]!;
    const botToken = first.botToken;
    const chatId = first.chatId;
    const ownerUid = first.ownerUid;
    const ownerIdentifier = first.ownerIdentifier;
    const telegramUserId = first.telegramUserId;

    const combinedText =
      items.map((i) => i.textPart).find((t) => t.trim()) || '';

    const mediaPaths: string[] = [];
    const attachmentOriginalNames: string[] = [];

    for (const item of items) {
      if (!item.attachment) continue;
      try {
        const incomingDir = this.workspaceService.getUserMediaIncomingDir(
          ownerIdentifier,
        );
        const ext = path.extname(item.attachment.suggestedName) || '';
        const dest = path.join(
          incomingDir,
          `${Date.now()}_${randomUUID().slice(0, 8)}${ext}`,
        );
        const { bytes } = await this.deliveryService.downloadTelegramFile(
          botToken,
          item.attachment.fileId,
          dest,
        );
        mediaPaths.push(dest);
        attachmentOriginalNames.push(item.attachment.suggestedName);
        this.logger.log(
          `Telegram album media saved: ${dest} (${bytes} bytes, ${item.attachment.suggestedName})`,
        );
      } catch (err: any) {
        this.logger.error(
          `Telegram album download failed: ${err?.message ?? err}`,
        );
        await this.deliveryService.sendTelegram(
          botToken,
          chatId,
          `⚠️ Không tải được file từ Telegram: ${err?.message ?? err}`,
        );
        return;
      }
    }

    for (let i = 0; i < mediaPaths.length; i++) {
      const p = mediaPaths[i]!;
      const name = attachmentOriginalNames[i];
      if (this.looksLikeJsonFile(name, p)) {
        const setup = await this.trySetupGoogleCredentialsFromJson(
          ownerUid,
          ownerIdentifier,
          telegramUserId,
          p,
        );
        if (setup.handled) {
          await this.deliveryService.sendTelegram(
            botToken,
            chatId,
            setup.message,
          );
          return;
        }
      }
    }

    const content =
      combinedText ||
      (mediaPaths.length
        ? `[User gửi ${mediaPaths.length} file / ảnh / video đính kèm — xem đường dẫn server trong nội dung đã ghép bên dưới.]`
        : '');

    if (!content.trim() && mediaPaths.length === 0) {
      this.logger.warn(`Telegram album flush: empty batch key=${key}`);
      return;
    }

    const mediaGroupId = key.split('\x1e')[2] ?? 'unknown';
    const messageIds = [...new Set(items.map((i) => i.messageId))].sort(
      (a, b) => a - b,
    );
    const dedupId = `tgAlbum:${mediaGroupId}:${messageIds.join('-')}`;

    const stopTyping = this.deliveryService.startTelegramTypingLoop(
      botToken,
      chatId,
    );
    try {
      const result = await this.gatewayService.handleMessage(ownerUid, content, {
        channelId: 'telegram',
        platform: ChatPlatform.TELEGRAM,
        telegramUserId,
        mediaPaths: mediaPaths.length ? mediaPaths : undefined,
        dedupId,
      });

      if (result.response) {
        await this.deliveryService.sendTelegram(
          botToken,
          chatId,
          result.response,
        );
      }
    } finally {
      stopTyping();
    }
  }

  async processUpdate(botToken: string, update: any): Promise<{ ok: true }> {
    // De-dup before any heavy work.
    if (this.isDuplicateUpdate(botToken, update)) {
      return { ok: true };
    }

    const message = update?.message;
    if (!message?.from) {
      return { ok: true };
    }

    const textPart = (message.text || message.caption || '').trim();
    const attachment = pickTelegramAttachment(message);
    if (!textPart && !attachment) {
      return { ok: true };
    }

    const telegramUserId = String(message.from.id);
    const chatId = message.chat.id;

    this.logger.debug(
      `Telegram update from ${telegramUserId} via bot ${botToken.slice(0, 8)}...`,
    );

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
      const invite =
        await this.botAccessService.getOrCreatePendingInviteByBotToken(
          botToken,
          BotPlatform.TELEGRAM,
          telegramUserId,
        );
      const deniedText = invite?.code
        ? `⛔️ Bạn chưa được cấp quyền dùng bot này. Mã xác thực của bạn là ${invite.code} (hết hạn sau 24 giờ). Hãy gửi mã này cho owner để owner duyệt kích hoạt bot nhé`
        : '⛔️ Bạn chưa được cấp quyền dùng bot này. Hãy nhắn mã xác thực 6 ký tự do owner cấp.';
      await this.deliveryService.sendTelegram(botToken, chatId, deniedText);
      return { ok: true };
    }

    const owner = await this.usersService.findById(ownerUid);
    if (!owner) {
      this.logger.error(`Owner user not found: ${ownerUid}`);
      return { ok: true };
    }

    await this.workspaceService.ensureUserWorkspace(owner.identifier);

    if (message.media_group_id != null) {
      const groupKey = `${botToken}\x1e${chatId}\x1e${String(message.media_group_id)}`;
      const arr = this.mediaGroupBuffers.get(groupKey) ?? [];
      arr.push({
        botToken,
        chatId,
        ownerUid: owner.uid,
        ownerIdentifier: owner.identifier,
        telegramUserId,
        updateId: update.update_id,
        messageId: message.message_id,
        textPart,
        attachment,
      });
      this.mediaGroupBuffers.set(groupKey, arr);
      this.scheduleMediaGroupFlush(groupKey);
      return { ok: true };
    }

    let mediaPath: string | undefined;
    let attachmentOriginalName: string | undefined;
    if (attachment) {
      try {
        const incomingDir = this.workspaceService.getUserMediaIncomingDir(
          owner.identifier,
        );
        const ext = path.extname(attachment.suggestedName) || '';
        const dest = path.join(
          incomingDir,
          `${Date.now()}_${randomUUID().slice(0, 8)}${ext}`,
        );
        const { bytes } = await this.deliveryService.downloadTelegramFile(
          botToken,
          attachment.fileId,
          dest,
        );
        mediaPath = dest;
        attachmentOriginalName = attachment.suggestedName;
        this.logger.log(
          `Telegram media saved: ${dest} (${bytes} bytes, ${attachment.suggestedName})`,
        );
      } catch (err: any) {
        this.logger.error(`Telegram download failed: ${err?.message ?? err}`);
        await this.deliveryService.sendTelegram(
          botToken,
          chatId,
          `⚠️ Không tải được file từ Telegram: ${err?.message ?? err}`,
        );
        return { ok: true };
      }
    }

    if (
      mediaPath &&
      this.looksLikeJsonFile(attachmentOriginalName, mediaPath)
    ) {
      const setup = await this.trySetupGoogleCredentialsFromJson(
        owner.uid,
        owner.identifier,
        telegramUserId,
        mediaPath,
      );
      if (setup.handled) {
        await this.deliveryService.sendTelegram(
          botToken,
          chatId,
          setup.message,
        );
        return { ok: true };
      }
    }

    const content =
      textPart ||
      (attachment
        ? '[User gửi file / ảnh / video đính kèm — xem đường dẫn server trong tin nhắn tiếp theo sau khi xử lý.]'
        : '');

    const stopTyping = this.deliveryService.startTelegramTypingLoop(
      botToken,
      chatId,
    );
    try {
      const result = await this.gatewayService.handleMessage(
        ownerUid,
        content,
        {
          channelId: 'telegram',
          platform: ChatPlatform.TELEGRAM,
          telegramUserId,
          mediaPath,
          dedupId:
            typeof update?.update_id === 'number'
              ? String(update.update_id)
              : undefined,
        },
      );

      if (result.response) {
        await this.deliveryService.sendTelegram(
          botToken,
          chatId,
          result.response,
        );
      }
    } finally {
      stopTyping();
    }

    return { ok: true };
  }

  private looksLikeJsonFile(
    suggestedName?: string,
    mediaPath?: string,
  ): boolean {
    const name = (suggestedName || '').toLowerCase();
    const p = (mediaPath || '').toLowerCase();
    return name.endsWith('.json') || p.endsWith('.json');
  }

  private isGoogleConsoleCredentialsJson(raw: string): boolean {
    try {
      const parsed = JSON.parse(raw);
      const root = parsed?.installed || parsed?.web;
      return !!(
        root &&
        typeof root.client_id === 'string' &&
        typeof root.client_secret === 'string' &&
        typeof root.auth_uri === 'string' &&
        typeof root.token_uri === 'string'
      );
    } catch {
      return false;
    }
  }

  private async trySetupGoogleCredentialsFromJson(
    ownerUid: number,
    ownerIdentifier: string,
    senderTelegramId: string,
    sourcePath: string,
  ): Promise<{ handled: boolean; message: string }> {
    const owner = await this.usersService.findById(ownerUid);
    if (!owner) {
      return {
        handled: true,
        message: '⛔ Không tìm thấy owner để cấu hình Google credentials.',
      };
    }

    // Only the bot owner (exact telegram_id) can configure Google credentials.
    if ((owner.telegramId || '').trim() !== senderTelegramId.trim()) {
      return {
        handled: true,
        message:
          '⛔ Chỉ Telegram ID của owner bot mới được phép cập nhật Google Console JSON.',
      };
    }

    let raw = '';
    try {
      raw = fs.readFileSync(sourcePath, 'utf-8');
    } catch {
      return {
        handled: true,
        message: '⚠️ Không đọc được file JSON vừa tải lên.',
      };
    }

    if (!this.isGoogleConsoleCredentialsJson(raw)) {
      return { handled: false, message: '' };
    }

    const workspaceDir =
      this.workspaceService.getUserWorkspaceDir(ownerIdentifier);
    const googleDir = path.join(workspaceDir, 'google');
    fs.mkdirSync(googleDir, { recursive: true });
    const targetPath = path.join(googleDir, 'console-cloud.json');

    // Store shortened "brain-relative" path in DB so we don't persist absolute disk paths.
    // Expected format (linux): /<identifier>/workspace/google/console-cloud.json
    const brainDir = this.workspaceService.getBrainDir();
    const relFromBrain = path.relative(brainDir, targetPath);
    const dbPath = '/' + relFromBrain.split(path.sep).join('/');

    // Single-file policy per user: always overwrite same destination file.
    fs.writeFileSync(targetPath, raw);

    await this.botUsersService.upsertGoogleCredentialsPath(
      ownerUid,
      dbPath,
    );

    return {
      handled: true,
      message:
        '✅ Đã lưu Google Console JSON thành công.\n' +
        `- File: ${targetPath}\n` +
        '- DB: đã cập nhật `bu_google_console_cloud_json_path`.\n' +
        '- Gửi lại file mới sẽ ghi đè file này (không tạo thêm bản mới).',
    };
  }
}
