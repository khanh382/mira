import { Injectable, Logger } from '@nestjs/common';
import { ILlmProvider, ILlmRequestOptions, ILlmResponse } from './interfaces/llm-provider.interface';

/**
 * ProvidersService quản lý registry LLM providers.
 * Kế thừa pattern provider resolution từ OpenClaw:
 * model string → tìm provider phù hợp → gọi API.
 */
@Injectable()
export class ProvidersService {
  private readonly logger = new Logger(ProvidersService.name);
  private readonly providers = new Map<string, ILlmProvider>();

  registerProvider(provider: ILlmProvider): void {
    this.providers.set(provider.providerId, provider);
    this.logger.log(
      `LLM Provider registered: ${provider.displayName} (${provider.supportedModels.length} models)`,
    );
  }

  getProvider(providerId: string): ILlmProvider | undefined {
    return this.providers.get(providerId);
  }

  listProviders(): ILlmProvider[] {
    return Array.from(this.providers.values());
  }

  listConfiguredProviders(): ILlmProvider[] {
    return this.listProviders().filter((p) => p.isConfigured());
  }

  /**
   * Resolve model string (e.g. "anthropic/claude-sonnet-4-20250514") → provider + model name.
   * Supports "provider/model" format or bare model name with auto-detection.
   */
  resolveProvider(model: string): { provider: ILlmProvider; modelName: string } | null {
    if (model.includes('/')) {
      const [providerId, ...rest] = model.split('/');
      const modelName = rest.join('/');
      const provider = this.providers.get(providerId);
      if (provider?.isConfigured()) {
        return { provider, modelName };
      }
    }

    for (const provider of this.providers.values()) {
      if (!provider.isConfigured()) continue;
      if (provider.supportedModels.some((m) => model.startsWith(m) || m.startsWith(model))) {
        return { provider, modelName: model };
      }
    }

    return null;
  }

  async chat(options: ILlmRequestOptions): Promise<ILlmResponse> {
    const resolved = this.resolveProvider(options.model);
    if (!resolved) {
      throw new Error(`No configured provider found for model: ${options.model}`);
    }

    return resolved.provider.chat({
      ...options,
      model: resolved.modelName,
    });
  }
}
