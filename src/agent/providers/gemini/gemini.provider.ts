import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ILlmProvider,
  ILlmRequestOptions,
  ILlmResponse,
} from '../interfaces/llm-provider.interface';

@Injectable()
export class GeminiProvider implements ILlmProvider {
  private readonly logger = new Logger(GeminiProvider.name);

  readonly providerId = 'gemini';
  readonly displayName = 'Google Gemini';
  readonly supportedModels = [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
  ];

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return !!this.configService.get('GEMINI_API_KEY');
  }

  async chat(options: ILlmRequestOptions): Promise<ILlmResponse> {
    // TODO: Implement Gemini API call
    throw new Error('Gemini provider not yet implemented');
  }
}
