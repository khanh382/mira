import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProvidersService } from '../../providers/providers.service';
import { MODEL_PRIORITY, ModelTier } from './model-tier.enum';

/**
 * Chọn model cho job LLM nền (tóm tắt, compact, extract preference, …).
 *
 * Thứ tự: `CONTEXT_FOCUS_MODEL` → `DEFAULT_MODEL` → từng model trong tier **CHEAP**
 * (`MODEL_PRIORITY[CHEAP]`) cho đến khi `ProvidersService` resolve được.
 */
@Injectable()
export class BackgroundLlmModelService {
  constructor(
    private readonly configService: ConfigService,
    private readonly providersService: ProvidersService,
  ) {}

  async resolveForBackgroundJob(): Promise<string | null> {
    await this.providersService.ensureProvidersReady();

    const fromEnv = [
      this.configService.get<string>('CONTEXT_FOCUS_MODEL')?.trim(),
      this.configService.get<string>('DEFAULT_MODEL')?.trim(),
    ].filter((m): m is string => Boolean(m));

    for (const m of fromEnv) {
      if (this.providersService.canResolveModel(m)) return m;
    }

    for (const candidate of MODEL_PRIORITY[ModelTier.CHEAP]) {
      if (this.providersService.canResolveModel(candidate.id)) {
        return candidate.id;
      }
    }

    return null;
  }
}
