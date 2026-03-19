import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ILlmProvider,
  ILlmRequestOptions,
  ILlmResponse,
} from '../interfaces/llm-provider.interface';

@Injectable()
export class OpenAIProvider implements ILlmProvider {
  private readonly logger = new Logger(OpenAIProvider.name);

  readonly providerId = 'openai';
  readonly displayName = 'OpenAI';
  readonly supportedModels = [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'gpt-4',
    'gpt-3.5-turbo',
    'o1',
    'o1-mini',
    'o3-mini',
  ];

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return !!this.configService.get('OPENAI_API_KEY');
  }

  async chat(options: ILlmRequestOptions): Promise<ILlmResponse> {
    // TODO: Implement OpenAI API call
    throw new Error('OpenAI provider not yet implemented');
  }
}
