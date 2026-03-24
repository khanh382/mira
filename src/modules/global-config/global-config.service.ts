import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Config } from './entities/config.entity';
import { UsersService } from '../users/users.service';
import { UserLevel } from '../users/entities/user.entity';

@Injectable()
export class GlobalConfigService {
  private readonly maskedValue = '*************';

  constructor(
    @InjectRepository(Config)
    private readonly configRepo: Repository<Config>,
    private readonly usersService: UsersService,
  ) {}

  async assertOwner(uid: number): Promise<void> {
    const user = await this.usersService.findById(uid);
    if (!user || user.level !== UserLevel.OWNER) {
      throw new ForbiddenException('Only owner can manage config');
    }
  }

  async getConfig(): Promise<Config | null> {
    return this.configRepo.findOne({ where: {} });
  }

  getMaskedConfig(config: Config | null): Config | null {
    if (!config) return null;

    const masked = { ...config } as Config;
    const apiKeyFields: (keyof Config)[] = [
      'openaiApiKey',
      'geminiApiKey',
      'anthropicApiKey',
      'openrouterApiKey',
      'deepseekApiKey',
      'kimiApiKey',
      'zaiApiKey',
      'perplexityApiKey',
      'braveApiKey',
      'firecrawlApiKey',
    ];

    for (const f of apiKeyFields) {
      const val = masked[f];
      if (typeof val === 'string' && val.trim()) {
        (masked as any)[f] = this.maskedValue;
      }
    }

    if (masked.ollama?.apiKey && String(masked.ollama.apiKey).trim()) {
      masked.ollama = { ...masked.ollama, apiKey: this.maskedValue };
    }
    if (masked.lmStudio?.apiKey && String(masked.lmStudio.apiKey).trim()) {
      masked.lmStudio = { ...masked.lmStudio, apiKey: this.maskedValue };
    }

    return masked;
  }

  async getApiKey(provider: string): Promise<string | null> {
    const config = await this.getConfig();
    if (!config) return null;

    const keyMap: Record<string, string> = {
      openai: config.openaiApiKey,
      gemini: config.geminiApiKey,
      anthropic: config.anthropicApiKey,
      openrouter: config.openrouterApiKey,
      deepseek: config.deepseekApiKey,
      kimi: config.kimiApiKey,
      zai: config.zaiApiKey,
      perplexity: config.perplexityApiKey,
      brave: config.braveApiKey,
      firecrawl: config.firecrawlApiKey,
    };

    return keyMap[provider] ?? null;
  }

  /** Trả về config Ollama (baseUrl + apiKey) hoặc null nếu chưa cấu hình. */
  async getOllamaConfig(): Promise<{ baseUrl: string; apiKey?: string | null } | null> {
    const config = await this.getConfig();
    if (!config?.ollama?.baseUrl?.trim()) return null;
    return config.ollama;
  }

  /** Trả về config LM Studio (baseUrl + apiKey) hoặc null nếu chưa cấu hình. */
  async getLmsConfig(): Promise<{ baseUrl: string; apiKey?: string | null } | null> {
    const config = await this.getConfig();
    if (!config?.lmStudio?.baseUrl?.trim()) return null;
    return config.lmStudio;
  }

  async updateConfig(data: Partial<Config>): Promise<Config> {
    let config = await this.getConfig();
    if (!config) {
      config = this.configRepo.create(data);
    } else {
      Object.assign(config, data);
    }
    return this.configRepo.save(config);
  }
}
