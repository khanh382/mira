import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ILlmProvider,
  ILlmRequestOptions,
  ILlmResponse,
} from '../interfaces/llm-provider.interface';

/**
 * OpenRouter là meta-provider, hỗ trợ truy cập nhiều model
 * từ nhiều provider khác nhau qua 1 API key duy nhất.
 */
@Injectable()
export class OpenRouterProvider implements ILlmProvider {
  private readonly logger = new Logger(OpenRouterProvider.name);

  readonly providerId = 'openrouter';
  readonly displayName = 'OpenRouter';
  readonly supportedModels = [];

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return !!this.configService.get('OPENROUTER_API_KEY');
  }

  async chat(options: ILlmRequestOptions): Promise<ILlmResponse> {
    // TODO: Implement OpenRouter API call
    throw new Error('OpenRouter provider not yet implemented');
  }
}
