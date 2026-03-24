import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BotUser } from './entities/bot-user.entity';

@Injectable()
export class BotUsersService {
  constructor(
    @InjectRepository(BotUser)
    private readonly botUserRepo: Repository<BotUser>,
  ) {}

  async findByUserId(userId: number): Promise<BotUser | null> {
    return this.botUserRepo.findOne({ where: { userId } });
  }

  async create(data: Partial<BotUser>): Promise<BotUser> {
    const botUser = this.botUserRepo.create(data);
    return this.botUserRepo.save(botUser);
  }

  async update(id: number, data: Partial<BotUser>): Promise<BotUser> {
    await this.botUserRepo.update(id, data);
    return this.botUserRepo.findOne({ where: { id } });
  }

  async upsertByUserId(userId: number, data: Partial<BotUser>): Promise<BotUser> {
    const existing = await this.findByUserId(userId);
    if (existing) {
      return this.update(existing.id, data);
    }
    return this.create({ userId, ...data });
  }

  toPublicRecord(row: BotUser) {
    return {
      id: row.id,
      userId: row.userId,
      telegramBotToken: row.telegramBotToken ?? null,
      discordBotToken: row.discordBotToken ?? null,
      slackBotToken: row.slackBotToken ?? null,
      zaloBotToken: row.zaloBotToken ?? null,
      googleConsoleCloudJsonPath: row.googleConsoleCloudJsonPath ?? null,
      createdAt: row.createdAt,
      updateAt: row.updateAt,
    };
  }

  async upsertGoogleCredentialsPath(
    userId: number,
    googleConsoleCloudJsonPath: string,
  ): Promise<BotUser> {
    return this.upsertByUserId(userId, { googleConsoleCloudJsonPath });
  }
}
