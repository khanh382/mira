import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
    if (platform === ChatPlatform.TELEGRAM) {
      where.telegramId = actor?.telegramId ?? null;
    } else if (platform === ChatPlatform.ZALO) {
      where.zaloId = actor?.zaloId ?? null;
    } else if (platform === ChatPlatform.DISCORD) {
      where.discordId = actor?.discordId ?? null;
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
    // Important: for UPDATE queries, TypeORM doesn't always expose the alias in SQL.
    // The previous implementation used `t.<col>` which caused:
    // "missing FROM-clause entry for table \"t\"".
    // Here we avoid alias prefixes for update statements.
    const qb = this.threadRepo
      .createQueryBuilder()
      .update(ChatThread)
      .set({ isActive: false })
      .where('userId = :userId', { userId })
      .andWhere('platform = :platform', { platform })
      .andWhere('isActive = true');

    if (platform === ChatPlatform.TELEGRAM) {
      if (actor.telegramId === null)
        qb.andWhere('telegramId IS NULL');
      else
        qb.andWhere('telegramId = :telegramId', { telegramId: actor.telegramId });
    } else if (platform === ChatPlatform.ZALO) {
      if (actor.zaloId === null) qb.andWhere('zaloId IS NULL');
      else qb.andWhere('zaloId = :zaloId', { zaloId: actor.zaloId });
    } else if (platform === ChatPlatform.DISCORD) {
      if (actor.discordId === null) qb.andWhere('discordId IS NULL');
      else qb.andWhere('discordId = :discordId', { discordId: actor.discordId });
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
