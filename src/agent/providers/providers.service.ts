import { Injectable, Logger } from '@nestjs/common';
import {
  ILlmProvider,
  ILlmRequestOptions,
  ILlmResponse,
} from './interfaces/llm-provider.interface';
import { GlobalConfigService } from '../../modules/global-config/global-config.service';

@Injectable()
export class ProvidersService {
  private readonly logger = new Logger(ProvidersService.name);
  private readonly providers = new Map<string, ILlmProvider>();
  private keysLoaded = false;

  constructor(private readonly globalConfigService: GlobalConfigService) {}

  registerProvider(provider: ILlmProvider): void {
    this.providers.set(provider.providerId, provider);
    this.logger.log(
      `LLM Provider registered: ${provider.displayName} (${provider.providerId})`,
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
   * Ensure all providers have loaded their API keys from DB.
   * Called lazily before first resolve/chat.
   */
  private async ensureKeysLoaded(): Promise<void> {
    if (this.keysLoaded) return;

    for (const provider of this.providers.values()) {
      if (typeof (provider as any).ensureKey === 'function') {
        await (provider as any).ensureKey();
      }
    }
    this.keysLoaded = true;
  }

  resolveProvider(
    model: string,
  ): { provider: ILlmProvider; modelName: string } | null {
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
      if (
        provider.supportedModels.some(
          (m) => model.startsWith(m) || m.startsWith(model),
        )
      ) {
        return { provider, modelName: model };
      }
    }

    return null;
  }

  async chat(options: ILlmRequestOptions): Promise<ILlmResponse> {
    await this.ensureKeysLoaded();

    const resolved = this.resolveProvider(options.model);
    if (!resolved) {
      throw new Error(
        `No configured provider found for model: ${options.model}`,
      );
    }

    return resolved.provider.chat({
      ...options,
      model: resolved.modelName,
    });
  }
}
