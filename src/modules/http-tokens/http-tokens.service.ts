import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UsersService } from '../users/users.service';
import { UserLevel } from '../users/entities/user.entity';
import { HttpToken, HttpTokenAuthType } from './entities/http-token.entity';

export interface UpsertHttpTokenInput {
  domain: string;
  authType: HttpTokenAuthType;
  headerName?: string | null;
  token: string;
  username?: string | null;
  note?: string | null;
}

@Injectable()
export class HttpTokensService {
  constructor(
    @InjectRepository(HttpToken)
    private readonly tokenRepo: Repository<HttpToken>,
    private readonly usersService: UsersService,
  ) {}

  normalizeDomain(input: string): string {
    const raw = String(input ?? '').trim().toLowerCase();
    if (!raw) throw new BadRequestException('domain is required');
    const candidate = raw.includes('://') ? raw : `https://${raw}`;
    let host = '';
    try {
      host = new URL(candidate).hostname.toLowerCase();
    } catch {
      throw new BadRequestException('domain is invalid');
    }
    return host.replace(/^www\./, '');
  }

  private maskToken(token: string): string {
    const t = String(token ?? '');
    if (t.length <= 8) return '***';
    return `${t.slice(0, 4)}...${t.slice(-4)}`;
  }

  private validateInput(input: UpsertHttpTokenInput): void {
    if (!String(input.token ?? '').trim()) {
      throw new BadRequestException('token is required');
    }
    if (input.authType === HttpTokenAuthType.API_KEY) {
      const name = String(input.headerName ?? '').trim();
      if (!name) {
        throw new BadRequestException(
          'headerName is required when authType=api_key',
        );
      }
    }
    if (input.authType === HttpTokenAuthType.BASIC) {
      const user = String(input.username ?? '').trim();
      if (!user) {
        throw new BadRequestException(
          'username is required when authType=basic',
        );
      }
    }
  }

  async assertOwner(uid: number): Promise<void> {
    const user = await this.usersService.findById(uid);
    if (!user || user.level !== UserLevel.OWNER) {
      throw new ForbiddenException('Only owner can manage HTTP tokens');
    }
  }

  toPublicRecord(row: HttpToken) {
    return {
      id: row.id,
      domain: row.domain,
      authType: row.authType,
      headerName: row.headerName,
      username: row.username,
      note: row.note,
      tokenMasked: this.maskToken(row.token),
      createdByUid: row.createdByUid,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async list(): Promise<HttpToken[]> {
    return this.tokenRepo.find({ order: { domain: 'ASC' } });
  }

  async getById(id: number): Promise<HttpToken> {
    const item = await this.tokenRepo.findOne({ where: { id } });
    if (!item) throw new NotFoundException('HTTP token not found');
    return item;
  }

  async getByDomain(domain: string): Promise<HttpToken | null> {
    return this.tokenRepo.findOne({ where: { domain: this.normalizeDomain(domain) } });
  }

  async upsert(
    input: UpsertHttpTokenInput,
    actorUid?: number,
  ): Promise<HttpToken> {
    this.validateInput(input);
    const domain = this.normalizeDomain(input.domain);
    const existing = await this.tokenRepo.findOne({ where: { domain } });
    const payload: Partial<HttpToken> = {
      domain,
      authType: input.authType,
      headerName: input.headerName ? String(input.headerName).trim() : null,
      token: String(input.token).trim(),
      username: input.username ? String(input.username).trim() : null,
      note: input.note ? String(input.note).trim() : null,
      createdByUid: actorUid ?? existing?.createdByUid ?? null,
    };
    if (existing) {
      await this.tokenRepo.update(existing.id, payload);
      return this.getById(existing.id);
    }
    const created = this.tokenRepo.create(payload);
    return this.tokenRepo.save(created);
  }

  async deleteById(id: number): Promise<void> {
    const item = await this.getById(id);
    await this.tokenRepo.delete(item.id);
  }
}
