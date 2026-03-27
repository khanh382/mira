import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GoogleConnection } from './entities/google-connection.entity';

@Injectable()
export class GoogleConnectionsService {
  constructor(
    @InjectRepository(GoogleConnection)
    private readonly repo: Repository<GoogleConnection>,
  ) {}

  async getByUserId(userId: number): Promise<GoogleConnection | null> {
    return this.repo.findOne({ where: { userId } });
  }

  async upsertConsoleCredentials(args: {
    userId: number;
    consoleCredentialsJson: string;
  }): Promise<GoogleConnection> {
    const existing = await this.getByUserId(args.userId);
    if (existing) {
      existing.consoleCredentialsJson = args.consoleCredentialsJson;
      return this.repo.save(existing);
    }
    return this.repo.save(
      this.repo.create({
        userId: args.userId,
        consoleCredentialsJson: args.consoleCredentialsJson,
        gogState: null,
        googleEmail: null,
      }),
    );
  }

  async updateGoogleEmail(userId: number, googleEmail: string | null) {
    const existing = await this.getByUserId(userId);
    if (!existing) {
      return this.repo.save(
        this.repo.create({
          userId,
          googleEmail,
          consoleCredentialsJson: null,
          gogState: null,
        }),
      );
    }
    existing.googleEmail = googleEmail;
    return this.repo.save(existing);
  }

  async updateGogState(userId: number, gogState: Record<string, string> | null) {
    const existing = await this.getByUserId(userId);
    if (!existing) {
      return this.repo.save(
        this.repo.create({
          userId,
          gogState,
          consoleCredentialsJson: null,
          googleEmail: null,
        }),
      );
    }
    existing.gogState = gogState;
    return this.repo.save(existing);
  }
}

