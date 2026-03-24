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
  code: string;
  domain: string;
  authType: HttpTokenAuthType;
  headerName?: string | null;
  token: string;
  username?: string | null;
  note?: string | null;
}

export interface CreateMyHttpTokenInput {
  code: string;
  domain: string;
  authType: HttpTokenAuthType;
  headerName?: string | null;
  token: string;
  username?: string | null;
  note?: string | null;
}

export interface UpdateMyHttpTokenInput {
  code?: string;
  domain?: string;
  authType?: HttpTokenAuthType;
  headerName?: string | null;
  token?: string;
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

  normalizeCode(input: string): string {
    const raw = String(input ?? '').trim().toLowerCase();
    if (!raw) throw new BadRequestException('code is required');
    if (!/^[a-z0-9._-]{3,120}$/.test(raw)) {
      throw new BadRequestException(
        'code is invalid (allowed: a-z, 0-9, ., _, -, length 3-120)',
      );
    }
    return raw;
  }

  private maskToken(token: string): string {
    const t = String(token ?? '');
    if (t.length <= 8) return '***';
    return `${t.slice(0, 4)}...${t.slice(-4)}`;
  }

  private validateInput(input: UpsertHttpTokenInput): void {
    this.normalizeCode(input.code);
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
      code: row.code,
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

  /**
   * Public record cho user self-service: khong tra ve token/tokenMasked.
   */
  toPublicWebsiteRecord(row: HttpToken) {
    return {
      id: row.id,
      code: row.code,
      domain: row.domain,
      authType: row.authType,
      headerName: row.headerName,
      username: row.username,
      note: row.note,
      createdByUid: row.createdByUid,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      hasToken: !!row.token,
    };
  }

  async list(): Promise<HttpToken[]> {
    return this.tokenRepo.find({ order: { code: 'ASC' } });
  }

  async getById(id: number): Promise<HttpToken> {
    const item = await this.tokenRepo.findOne({ where: { id } });
    if (!item) throw new NotFoundException('HTTP token not found');
    return item;
  }

  async getByDomain(domain: string): Promise<HttpToken | null> {
    return this.tokenRepo.findOne({
      where: { domain: this.normalizeDomain(domain) },
      order: { id: 'DESC' },
    });
  }

  async getByCode(code: string): Promise<HttpToken | null> {
    return this.tokenRepo.findOne({ where: { code: this.normalizeCode(code) } });
  }

  async upsert(
    input: UpsertHttpTokenInput,
    actorUid?: number,
  ): Promise<HttpToken> {
    this.validateInput(input);
    const code = this.normalizeCode(input.code);
    const domain = this.normalizeDomain(input.domain);
    const existing = await this.tokenRepo.findOne({ where: { code } });
    const payload: Partial<HttpToken> = {
      code,
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

  async listByUser(uid: number): Promise<HttpToken[]> {
    return this.tokenRepo.find({
      where: { createdByUid: uid },
      order: { code: 'ASC' },
    });
  }

  async getByIdForUser(id: number, uid: number): Promise<HttpToken> {
    const item = await this.tokenRepo.findOne({ where: { id, createdByUid: uid } });
    if (!item) throw new NotFoundException('Website token not found');
    return item;
  }

  async createForUser(input: CreateMyHttpTokenInput, uid: number): Promise<HttpToken> {
    this.validateInput({
      ...input,
      token: String(input.token ?? ''),
    });
    const domain = this.normalizeDomain(input.domain);
    const code = this.normalizeCode(input.code);
    const existingCode = await this.tokenRepo.findOne({ where: { code } });
    if (existingCode) {
      throw new BadRequestException('Code already exists');
    }
    const existing = await this.tokenRepo.findOne({ where: { domain, createdByUid: uid } });
    if (existing) {
      throw new BadRequestException('Domain already exists in your websites');
    }
    const row = this.tokenRepo.create({
      code,
      domain,
      authType: input.authType,
      headerName: input.headerName ? String(input.headerName).trim() : null,
      token: String(input.token).trim(),
      username: input.username ? String(input.username).trim() : null,
      note: input.note ? String(input.note).trim() : null,
      createdByUid: uid,
    });
    return this.tokenRepo.save(row);
  }

  async updateForUser(
    id: number,
    uid: number,
    input: UpdateMyHttpTokenInput,
  ): Promise<HttpToken> {
    const item = await this.getByIdForUser(id, uid);

    if (input.domain !== undefined) {
      const normalized = this.normalizeDomain(input.domain);
      const existing = await this.tokenRepo.findOne({
        where: { domain: normalized, createdByUid: uid },
      });
      if (existing && existing.id !== item.id) {
        throw new BadRequestException('Domain already exists in your websites');
      }
      item.domain = normalized;
    }
    if (input.code !== undefined) {
      const normalizedCode = this.normalizeCode(input.code);
      const existingCode = await this.tokenRepo.findOne({
        where: { code: normalizedCode },
      });
      if (existingCode && existingCode.id !== item.id) {
        throw new BadRequestException('Code already exists');
      }
      item.code = normalizedCode;
    }
    if (input.authType !== undefined) item.authType = input.authType;
    if (input.headerName !== undefined) {
      item.headerName = input.headerName ? String(input.headerName).trim() : null;
    }
    if (input.username !== undefined) {
      item.username = input.username ? String(input.username).trim() : null;
    }
    if (input.note !== undefined) {
      item.note = input.note ? String(input.note).trim() : null;
    }
    if (input.token !== undefined) {
      if (!String(input.token).trim()) {
        throw new BadRequestException('token cannot be empty');
      }
      item.token = String(input.token).trim();
    }

    // Validate theo authType sau khi merge patch.
    this.validateInput({
      code: item.code,
      domain: item.domain,
      authType: item.authType,
      headerName: item.headerName,
      token: item.token,
      username: item.username,
      note: item.note,
    });

    return this.tokenRepo.save(item);
  }

  async deleteByIdForUser(id: number, uid: number): Promise<void> {
    const item = await this.getByIdForUser(id, uid);
    await this.tokenRepo.delete(item.id);
  }
}
