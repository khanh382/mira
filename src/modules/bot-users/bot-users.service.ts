import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BotUser } from './entities/bot-user.entity';

@Injectable()
export class BotUsersService {
  private static readonly MASKED_TOKEN = '*********************************************';

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
    const mask = (value?: string | null): string | null => {
      const v = String(value ?? '').trim();
      return v.length > 0 ? BotUsersService.MASKED_TOKEN : null;
    };
    return {
      id: row.id,
      userId: row.userId,
      telegramBotToken: mask(row.telegramBotToken),
      discordBotToken: mask(row.discordBotToken),
      slackBotToken: mask(row.slackBotToken),
      zaloBotToken: mask(row.zaloBotToken),
      createdAt: row.createdAt,
      updateAt: row.updateAt,
    };
  }
}
