import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { ChatThread, ChatPlatform } from './entities/chat-thread.entity';

@Injectable()
export class ThreadsService {
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
  ): Promise<ChatThread | null> {
    return this.threadRepo.findOne({
      where: { userId, platform, isActive: true },
      order: { updatedAt: 'DESC' },
    });
  }

  async listByUserId(userId: number, includeInactive = false): Promise<ChatThread[]> {
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
  }): Promise<ChatThread> {
    const thread = this.threadRepo.create({
      id: uuidv4(),
      userId: data.userId,
      platform: data.platform ?? ChatPlatform.WEB,
      title: data.title,
      isActive: true,
    });
    return this.threadRepo.save(thread);
  }

  async touch(threadId: string): Promise<void> {
    await this.threadRepo.update(threadId, { updatedAt: new Date() });
  }

  async updateTitle(threadId: string, title: string): Promise<void> {
    await this.threadRepo.update(threadId, { title });
  }

  async deactivate(threadId: string): Promise<void> {
    await this.threadRepo.update(threadId, { isActive: false });
  }
}
