import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { ChatThread, ChatPlatform } from './entities/chat-thread.entity';

@Injectable()
export class ThreadsService {
  private readonly logger = new Logger(ThreadsService.name);
  constructor(
    @InjectRepository(ChatThread)
    private readonly threadRepo: Repository<ChatThread>,
  ) {}

  async findById(threadId: string): Promise<ChatThread | null> {
    return this.threadRepo.findOne({ where: { id: threadId } });
  }

  async findActiveByUserId(userId: number): Promise<ChatThread | null> {
    return this.threadRepo.findOne({
      where: { userId, isActive: true },
      order: { updatedAt: 'DESC' },
    });
  }

  async findActiveByUserAndPlatform(
    userId: number,
    platform: ChatPlatform,
    actor?: { telegramId?: string; zaloId?: string; discordId?: string },
  ): Promise<ChatThread | null> {
    const where: any = { userId, platform, isActive: true };

    // Use TypeORM's IsNull() operator for null values — plain `null` can be
    // silently dropped from the WHERE clause by some TypeORM versions, causing
    // the query to return the most-recently-updated thread regardless of the
    // platform-id column.
    if (platform === ChatPlatform.TELEGRAM) {
      const v = actor?.telegramId ?? null;
      where.telegramId = v === null ? IsNull() : v;
    } else if (platform === ChatPlatform.ZALO) {
      const v = actor?.zaloId ?? null;
      where.zaloId = v === null ? IsNull() : v;
    } else if (platform === ChatPlatform.DISCORD) {
      const v = actor?.discordId ?? null;
      where.discordId = v === null ? IsNull() : v;
    }

    return this.threadRepo.findOne({
      where,
      order: { updatedAt: 'DESC' },
    });
  }

  async listByUserId(
    userId: number,
    includeInactive = false,
  ): Promise<ChatThread[]> {
    const where: any = { userId };
    if (!includeInactive) {
      where.isActive = true;
    }
    return this.threadRepo.find({
      where,
      order: { updatedAt: 'DESC' },
    });
  }

  async create(data: {
    userId: number;
    platform?: ChatPlatform;
    title?: string;
    telegramId?: string | null;
    zaloId?: string | null;
    discordId?: string | null;
  }): Promise<ChatThread> {
    const thread = this.threadRepo.create({
      id: uuidv4(),
      userId: data.userId,
      platform: data.platform ?? ChatPlatform.WEB,
      telegramId: data.telegramId ?? null,
      zaloId: data.zaloId ?? null,
      discordId: data.discordId ?? null,
      title: data.title,
      isActive: true,
    });
    return this.threadRepo.save(thread);
  }

  async touch(threadId: string): Promise<void> {
    await this.threadRepo.update(threadId, { updatedAt: new Date() });
  }

  async activate(threadId: string): Promise<void> {
    await this.threadRepo.update(threadId, {
      isActive: true,
      updatedAt: new Date(),
    });
  }

  async setActiveOpenclawAgent(
    threadId: string,
    activeOpenclawAgentId: number | null,
  ): Promise<void> {
    await this.threadRepo.update(threadId, {
      activeOpenclawAgentId,
      updatedAt: new Date(),
    });
  }

  async updateTitle(threadId: string, title: string): Promise<void> {
    await this.threadRepo.update(threadId, { title });
  }

  async deactivate(threadId: string): Promise<void> {
    await this.threadRepo.update(threadId, { isActive: false });
  }

  /**
   * Ensure only one active thread for the same (userId, platform, actorKey).
   * Useful to avoid duplicated "active sessions" when session keys change.
   */
  async deactivateActiveByUserAndPlatformAndActorKey(
    userId: number,
    platform: ChatPlatform,
    actor: { telegramId?: string | null; zaloId?: string | null; discordId?: string | null },
  ): Promise<void> {
    // Use actual DB column names in raw QueryBuilder WHERE strings —
    // TypeORM does NOT map entity property names in raw .where() fragments.
    const qb = this.threadRepo
      .createQueryBuilder()
      .update(ChatThread)
      .set({ isActive: false })
      .where('"uid" = :userId', { userId })
      .andWhere('"platform" = :platform', { platform })
      .andWhere('"is_active" = true');

    if (platform === ChatPlatform.TELEGRAM) {
      if (actor.telegramId === null)
        qb.andWhere('"telegram_id" IS NULL');
      else
        qb.andWhere('"telegram_id" = :telegramId', { telegramId: actor.telegramId });
    } else if (platform === ChatPlatform.ZALO) {
      if (actor.zaloId === null) qb.andWhere('"zalo_id" IS NULL');
      else qb.andWhere('"zalo_id" = :zaloId', { zaloId: actor.zaloId });
    } else if (platform === ChatPlatform.DISCORD) {
      if (actor.discordId === null) qb.andWhere('"discord_id" IS NULL');
      else qb.andWhere('"discord_id" = :discordId', { discordId: actor.discordId });
    }

    const res = await qb.execute();
    this.logger.debug(
      `[ThreadsService] deactivateActiveByUserAndPlatformAndActorKey affected=${(res as any)?.affected ?? 'unknown'} userId=${userId} platform=${platform} actor=${JSON.stringify(
        actor,
      )}`,
    );
  }

  async deleteById(threadId: string): Promise<void> {
    await this.threadRepo.delete(threadId);
  }
}
