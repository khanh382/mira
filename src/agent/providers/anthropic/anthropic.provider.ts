import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ILlmProvider,
  ILlmRequestOptions,
  ILlmResponse,
} from '../interfaces/llm-provider.interface';

@Injectable()
export class AnthropicProvider implements ILlmProvider {
  private readonly logger = new Logger(AnthropicProvider.name);

  readonly providerId = 'anthropic';
  readonly displayName = 'Anthropic';
  readonly supportedModels = [
    'claude-sonnet-4-20250514',
    'claude-opus-4-6',
    'claude-3-haiku',
    'claude-3-sonnet',
    'claude-3-opus',
  ];

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return !!this.configService.get('ANTHROPIC_API_KEY');
  }

  async chat(options: ILlmRequestOptions): Promise<ILlmResponse> {
    // TODO: Implement Anthropic API call
    throw new Error('Anthropic provider not yet implemented');
  }
}
