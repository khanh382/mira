import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { N8nApiKey } from './entities/n8n-api-key.entity';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

@Injectable()
export class N8nApiKeysService {
  constructor(
    @InjectRepository(N8nApiKey)
    private readonly repo: Repository<N8nApiKey>,
  ) {}

  private normalizeLabel(label: string | undefined | null): string {
    const raw = String(label ?? '').trim();
    if (!raw) return 'default';
    if (raw.length > 120) return raw.slice(0, 120);
    return raw;
  }

  generateToken(): string {
    // URL-safe-ish; long enough for security; user will store in n8n credentials.
    return `mira_${randomBytes(24).toString('hex')}`;
  }

  async createForUser(args: {
    userId: number;
    label?: string | null;
  }): Promise<{ row: N8nApiKey; token: string }> {
    const token = this.generateToken();
    const row = this.repo.create({
      userId: args.userId,
      label: this.normalizeLabel(args.label),
      tokenHash: sha256Hex(token),
      revokedAt: null,
      lastUsedAt: null,
    });
    return { row: await this.repo.save(row), token };
  }

  async verifyTokenOrNull(rawToken: string): Promise<N8nApiKey | null> {
    const token = String(rawToken ?? '').trim();
    if (!token) return null;
    const tokenHash = sha256Hex(token);
    const row = await this.repo.findOne({ where: { tokenHash } });
    if (!row || row.revokedAt) return null;
    await this.repo.update(row.id, { lastUsedAt: new Date() });
    return row;
  }

  async revoke(args: { id: string; userId: number }): Promise<void> {
    const row = await this.repo.findOne({ where: { id: args.id } });
    if (!row) return;
    if (row.userId !== args.userId) {
      throw new BadRequestException('Cannot revoke keys belonging to other users');
    }
    await this.repo.update(row.id, { revokedAt: new Date() });
  }

  async listByUser(userId: number): Promise<N8nApiKey[]> {
    return this.repo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 200,
    });
  }
}

