import { Module } from '@nestjs/common';
import { ModelRouterService } from './model-router.service';
import { BackgroundLlmModelService } from './background-llm-model.service';
import { GlobalConfigModule } from '../../../modules/global-config/global-config.module';
import { UsersModule } from '../../../modules/users/users.module';
import { ProvidersModule } from '../../providers/providers.module';

@Module({
  imports: [GlobalConfigModule, UsersModule, ProvidersModule],
  providers: [ModelRouterService, BackgroundLlmModelService],
  exports: [ModelRouterService, BackgroundLlmModelService],
})
export class ModelRouterModule {}
