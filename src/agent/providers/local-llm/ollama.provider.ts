import { Injectable } from '@nestjs/common';
import { GlobalConfigService } from '../../../modules/global-config/global-config.service';
import { LocalLlmConfig, LocalLlmProvider } from './local-llm.provider';

/**
 * OllamaProvider — Ollama local inference server.
 * API mặc định: http://localhost:11434/v1/chat/completions (OpenAI-compatible).
 * Cấu hình qua cot_ollama JSON trong bảng config: { baseUrl, apiKey? }.
 */
@Injectable()
export class OllamaProvider extends LocalLlmProvider {
  readonly providerId = 'ollama';
  readonly displayName = 'Ollama';

  constructor(globalConfigService: GlobalConfigService) {
    super(globalConfigService);
  }

  protected async loadConfig(): Promise<LocalLlmConfig | null> {
    return this.globalConfigService.getOllamaConfig();
  }
}
