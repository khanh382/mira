import { Injectable } from '@nestjs/common';
import { GlobalConfigService } from '../../../modules/global-config/global-config.service';
import { LocalLlmConfig, LocalLlmProvider } from './local-llm.provider';

/**
 * LmStudioProvider — LM Studio local inference server.
 * API mặc định: http://localhost:1234/v1/chat/completions (OpenAI-compatible).
 * Cấu hình qua cof_lms JSON trong bảng config: { baseUrl, apiKey? }.
 */
@Injectable()
export class LmStudioProvider extends LocalLlmProvider {
  readonly providerId = 'lmstudio';
  readonly displayName = 'LM Studio';

  constructor(globalConfigService: GlobalConfigService) {
    super(globalConfigService);
  }

  protected async loadConfig(): Promise<LocalLlmConfig | null> {
    return this.globalConfigService.getLmsConfig();
  }
}
