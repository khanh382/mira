import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Config } from './entities/config.entity';

@Injectable()
export class GlobalConfigService {
  constructor(
    @InjectRepository(Config)
    private readonly configRepo: Repository<Config>,
  ) {}

  async getConfig(): Promise<Config | null> {
    return this.configRepo.findOne({ where: {} });
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
