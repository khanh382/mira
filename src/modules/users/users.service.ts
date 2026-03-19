import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async findById(uid: number): Promise<User | null> {
    return this.userRepo.findOne({ where: { uid } });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { email } });
  }

  async findByIdentifier(identifier: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { identifier } });
  }

  async findByPlatformId(field: string, value: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { [field]: value } as any });
  }

  async findByTelegramId(telegramId: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { telegramId } });
  }

  async findByDiscordId(discordId: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { discordId } });
  }

  async findByZaloId(zaloId: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { zaloId } });
  }

  async findBySlackId(slackId: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { slackId } });
  }

  async create(data: Partial<User>): Promise<User> {
    const user = this.userRepo.create(data);
    return this.userRepo.save(user);
  }

  async update(uid: number, data: Partial<User>): Promise<User> {
    await this.userRepo.update(uid, data);
    return this.findById(uid);
  }
}
