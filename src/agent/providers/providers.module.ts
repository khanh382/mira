import { Module } from '@nestjs/common';
import { ProvidersService } from './providers.service';
import { GlobalConfigModule } from '../../modules/global-config/global-config.module';
import { OllamaProvider } from './local-llm/ollama.provider';
import { LmStudioProvider } from './local-llm/lmstudio.provider';

@Module({
  imports: [GlobalConfigModule],
  providers: [ProvidersService, OllamaProvider, LmStudioProvider],
  exports: [ProvidersService, OllamaProvider, LmStudioProvider],
})
export class ProvidersModule {}
