import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ILlmProvider,
  ILlmRequestOptions,
  ILlmResponse,
} from '../interfaces/llm-provider.interface';

@Injectable()
export class DeepSeekProvider implements ILlmProvider {
  private readonly logger = new Logger(DeepSeekProvider.name);

  readonly providerId = 'deepseek';
  readonly displayName = 'DeepSeek';
  readonly supportedModels = [
    'deepseek-v3.2',
    'deepseek-chat',
    'deepseek-reasoner',
  ];

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return !!this.configService.get('DEEPSEEK_API_KEY');
  }

  async chat(options: ILlmRequestOptions): Promise<ILlmResponse> {
    // TODO: Implement DeepSeek API call
    throw new Error('DeepSeek provider not yet implemented');
  }
}
