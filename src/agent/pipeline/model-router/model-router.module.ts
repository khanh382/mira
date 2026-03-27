import { Module } from '@nestjs/common';
import { ModelRouterService } from './model-router.service';
import { BackgroundLlmModelService } from './background-llm-model.service';
import { GlobalConfigModule } from '../../../modules/global-config/global-config.module';
import { UsersModule } from '../../../modules/users/users.module';
import { ProvidersModule } from '../../providers/providers.module';
import { AgentFeedbackModule } from '../../feedback/agent-feedback.module';
import { ModelPolicyModule } from '../../model-policy/model-policy.module';

@Module({
  imports: [
    GlobalConfigModule,
    UsersModule,
    ProvidersModule,
    AgentFeedbackModule,
    ModelPolicyModule,
  ],
  providers: [ModelRouterService, BackgroundLlmModelService],
  exports: [ModelRouterService, BackgroundLlmModelService],
})
export class ModelRouterModule {}
