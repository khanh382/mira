import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { ChatMessage, MessageRole } from './entities/chat-message.entity';

@Injectable()
export class ChatService {
  constructor(
    @InjectRepository(ChatMessage)
    private readonly messageRepo: Repository<ChatMessage>,
  ) {}

  async findByThreadId(
    threadId: string,
    limit = 50,
  ): Promise<ChatMessage[]> {
    return this.messageRepo.find({
      where: { threadId },
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  async getRecentMessages(
    threadId: string,
    limit = 20,
  ): Promise<ChatMessage[]> {
    return this.messageRepo.find({
      where: { threadId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async createMessage(data: {
    threadId: string;
    userId: number;
    role: MessageRole;
    content: string;
    tokensUsed?: number;
  }): Promise<ChatMessage> {
    const message = this.messageRepo.create({
      id: uuidv4(),
      ...data,
    });
    return this.messageRepo.save(message);
  }

  async findUnvectorized(limit = 100): Promise<ChatMessage[]> {
    return this.messageRepo.find({
      where: { isVectorized: false },
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  async markVectorized(ids: string[]): Promise<void> {
    await this.messageRepo.update(ids, { isVectorized: true });
  }

  async findUnexported(limit = 100): Promise<ChatMessage[]> {
    return this.messageRepo.find({
      where: { isExported: false },
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  async markExported(ids: string[]): Promise<void> {
    await this.messageRepo.update(ids, { isExported: true });
  }

  async countByUser(userId: number): Promise<number> {
    return this.messageRepo.count({ where: { userId } });
  }

  async getTokenUsageByUser(userId: number): Promise<number> {
    const result = await this.messageRepo
      .createQueryBuilder('msg')
      .select('SUM(msg.tokens_used)', 'total')
      .where('msg.uid = :userId', { userId })
      .getRawOne();
    return parseInt(result?.total ?? '0', 10);
  }
}
