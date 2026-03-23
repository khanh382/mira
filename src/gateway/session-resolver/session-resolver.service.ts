import { Injectable, Logger } from '@nestjs/common';
import { ThreadsService } from '../../modules/chat/threads.service';
import { UsersService } from '../../modules/users/users.service';
import { WorkspaceService } from '../workspace/workspace.service';
import {
  ChatThread,
  ChatPlatform,
} from '../../modules/chat/entities/chat-thread.entity';
import { User } from '../../modules/users/entities/user.entity';

export interface ResolvedThread {
  user: User;
  thread: ChatThread;
  isNew: boolean;
}

/**
 * ThreadResolverService — tìm hoặc tạo chat thread cho user.
 *
 * Mỗi user có thể có nhiều threads (per-platform hoặc tạo mới tùy ý).
 * - Nếu chưa có active thread trên platform → tạo mới + provision workspace
 * - Touch updatedAt mỗi lần dùng
 */
@Injectable()
export class ThreadResolverService {
  private readonly logger = new Logger(ThreadResolverService.name);

  constructor(
    private readonly threadsService: ThreadsService,
    private readonly usersService: UsersService,
    private readonly workspaceService: WorkspaceService,
  ) {}

  async resolve(
    userId: number,
    platform: ChatPlatform = ChatPlatform.WEB,
    actor?: { telegramId?: string; zaloId?: string; discordId?: string },
  ): Promise<ResolvedThread> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    await this.workspaceService.ensureUserWorkspace(user.identifier);

    const normalize = (v: unknown): string => String(v ?? '').trim();
    const actorTelegramId = normalize(actor?.telegramId);
    const actorZaloId = normalize(actor?.zaloId);
    const actorDiscordId = normalize(actor?.discordId);
    const ownerTelegramId = normalize((user as any).telegramId);
    const ownerZaloId = normalize((user as any).zaloId);
    const ownerDiscordId = normalize((user as any).discordId);

    const isOwnerActor =
      (platform === ChatPlatform.TELEGRAM && actorTelegramId && ownerTelegramId
        ? actorTelegramId === ownerTelegramId
        : false) ||
      (platform === ChatPlatform.ZALO && actorZaloId && ownerZaloId
        ? actorZaloId === ownerZaloId
        : false) ||
      (platform === ChatPlatform.DISCORD && actorDiscordId && ownerDiscordId
        ? actorDiscordId === ownerDiscordId
        : false);

    // Try the exact platform-id match first, then fall back to legacy NULL key.
    // Previous order [null, id] caused cross-talk: TypeORM could silently drop
    // the null condition from the WHERE clause, returning the most-recently-
    // updated thread regardless of the platform-id column.
    const ownerKeyCandidates =
      platform === ChatPlatform.TELEGRAM
        ? isOwnerActor
          ? [actorTelegramId, null]
          : [actorTelegramId]
        : platform === ChatPlatform.ZALO
          ? isOwnerActor
            ? [actorZaloId, null]
            : [actorZaloId]
          : platform === ChatPlatform.DISCORD
            ? isOwnerActor
              ? [actorDiscordId, null]
              : [actorDiscordId]
            : [undefined];

    let thread: ChatThread | null = null;
    for (const key of ownerKeyCandidates) {
      const actorKey =
        platform === ChatPlatform.TELEGRAM
          ? { telegramId: key as any }
          : platform === ChatPlatform.ZALO
            ? { zaloId: key as any }
            : platform === ChatPlatform.DISCORD
              ? { discordId: key as any }
              : {};
      thread = await this.threadsService.findActiveByUserAndPlatform(
        userId,
        platform,
        actorKey as any,
      );
      if (thread) break;
    }

    let isNew = false;

    if (thread) {
      await this.threadsService.touch(thread.id);
      return { user, thread, isNew };
    }

    // Create thread:
    // - for owner: gán luôn platform id của chính owner (không NULL)
    // - for guest: gán platform id của actor (người chat)
    const createActor =
      platform === ChatPlatform.TELEGRAM
        ? {
            telegramId: isOwnerActor
              ? ownerTelegramId || null
              : actorTelegramId || null,
          }
        : platform === ChatPlatform.ZALO
          ? {
              zaloId: isOwnerActor
                ? ownerZaloId || null
                : actorZaloId || null,
            }
          : platform === ChatPlatform.DISCORD
            ? {
                discordId: isOwnerActor
                  ? ownerDiscordId || null
                  : actorDiscordId || null,
              }
            : {};

    // If we are creating a new active thread for this actor key, make sure
    // there isn't an older duplicate active thread for the same key.
    await this.threadsService.deactivateActiveByUserAndPlatformAndActorKey(
      user.uid,
      platform,
      {
        telegramId: platform === ChatPlatform.TELEGRAM ? (createActor as any).telegramId : undefined,
        zaloId: platform === ChatPlatform.ZALO ? (createActor as any).zaloId : undefined,
        discordId: platform === ChatPlatform.DISCORD ? (createActor as any).discordId : undefined,
      } as any,
    );

    thread = await this.threadsService.create({
      userId: user.uid,
      platform,
      telegramId:
        platform === ChatPlatform.TELEGRAM
          ? (createActor as any).telegramId
          : null,
      zaloId:
        platform === ChatPlatform.ZALO ? (createActor as any).zaloId : null,
      discordId:
        platform === ChatPlatform.DISCORD ? (createActor as any).discordId : null,
    });
    isNew = true;

    this.logger.log(
      `New thread created for user ${user.identifier} on ${platform}: ${thread.id} ` +
        `(actorKey=${JSON.stringify({
          telegramId: thread.telegramId,
          zaloId: thread.zaloId,
          discordId: thread.discordId,
        })})`,
    );

    return { user, thread, isNew };
  }

  async reset(
    userId: number,
    platform: ChatPlatform = ChatPlatform.WEB,
    actor?: { telegramId?: string; zaloId?: string; discordId?: string },
  ): Promise<ResolvedThread> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const normalize = (v: unknown): string => String(v ?? '').trim();
    const actorTelegramId = normalize(actor?.telegramId);
    const actorZaloId = normalize(actor?.zaloId);
    const actorDiscordId = normalize(actor?.discordId);
    const ownerTelegramId = normalize((user as any).telegramId);
    const ownerZaloId = normalize((user as any).zaloId);
    const ownerDiscordId = normalize((user as any).discordId);

    const isOwnerActor =
      (platform === ChatPlatform.TELEGRAM && actorTelegramId && ownerTelegramId
        ? actorTelegramId === ownerTelegramId
        : false) ||
      (platform === ChatPlatform.ZALO && actorZaloId && ownerZaloId
        ? actorZaloId === ownerZaloId
        : false) ||
      (platform === ChatPlatform.DISCORD && actorDiscordId && ownerDiscordId
        ? actorDiscordId === ownerDiscordId
        : false);

    const ownerKeyCandidates =
      platform === ChatPlatform.TELEGRAM
        ? isOwnerActor
          ? [actorTelegramId, null]
          : [actorTelegramId]
        : platform === ChatPlatform.ZALO
          ? isOwnerActor
            ? [actorZaloId, null]
            : [actorZaloId]
          : platform === ChatPlatform.DISCORD
            ? isOwnerActor
              ? [actorDiscordId, null]
              : [actorDiscordId]
            : [undefined];

    // Deactivate first matching active thread.
    for (const key of ownerKeyCandidates) {
      const actorKey =
        platform === ChatPlatform.TELEGRAM
          ? { telegramId: key as any }
          : platform === ChatPlatform.ZALO
            ? { zaloId: key as any }
            : platform === ChatPlatform.DISCORD
              ? { discordId: key as any }
              : {};

      const current = await this.threadsService.findActiveByUserAndPlatform(
        userId,
        platform,
        actorKey as any,
      );
      if (current) {
        await this.threadsService.deactivate(current.id);
        this.logger.log(`Thread deactivated: ${current.id}`);
        break;
      }
    }

    const createActor =
      platform === ChatPlatform.TELEGRAM
        ? {
            telegramId: isOwnerActor
              ? ownerTelegramId || null
              : actorTelegramId || null,
          }
        : platform === ChatPlatform.ZALO
          ? {
              zaloId: isOwnerActor
                ? ownerZaloId || null
                : actorZaloId || null,
            }
          : platform === ChatPlatform.DISCORD
            ? {
                discordId: isOwnerActor
                  ? ownerDiscordId || null
                  : actorDiscordId || null,
              }
            : {};

    await this.threadsService.deactivateActiveByUserAndPlatformAndActorKey(
      user.uid,
      platform,
      {
        telegramId: platform === ChatPlatform.TELEGRAM ? (createActor as any).telegramId : undefined,
        zaloId: platform === ChatPlatform.ZALO ? (createActor as any).zaloId : undefined,
        discordId: platform === ChatPlatform.DISCORD ? (createActor as any).discordId : undefined,
      } as any,
    );

    const thread = await this.threadsService.create({
      userId: user.uid,
      platform,
      telegramId:
        platform === ChatPlatform.TELEGRAM
          ? (createActor as any).telegramId
          : null,
      zaloId:
        platform === ChatPlatform.ZALO ? (createActor as any).zaloId : null,
      discordId:
        platform === ChatPlatform.DISCORD
          ? (createActor as any).discordId
          : null,
    });

    this.logger.log(
      `Thread reset for user ${user.identifier} on ${platform}: ${thread.id}`,
    );

    return { user, thread, isNew: true };
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.threadsService.deleteById(threadId);
    this.logger.log(`Thread deleted: ${threadId}`);
  }
}
