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

  async upsertGoogleCredentialsPath(
    userId: number,
    googleConsoleCloudJsonPath: string,
  ): Promise<BotUser> {
    const existing = await this.findByUserId(userId);
    if (existing) {
      return this.update(existing.id, { googleConsoleCloudJsonPath });
    }
    return this.create({
      userId,
      googleConsoleCloudJsonPath,
    });
  }
}
