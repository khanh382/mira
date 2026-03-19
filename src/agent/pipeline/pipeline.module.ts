import { Module, forwardRef } from '@nestjs/common';
import { PipelineService } from './pipeline.service';
import { ReceiveStep } from './steps/receive.step';
import { PreprocessStep } from './steps/preprocess.step';
import { RouteStep } from './steps/route.step';
import { AgentRunStep } from './steps/agent-run.step';
import { DeliverStep } from './steps/deliver.step';
import { ChannelsModule } from '../channels/channels.module';
import { ProvidersModule } from '../providers/providers.module';
import { SkillsModule } from '../skills/skills.module';
import { ModelRouterModule } from './model-router/model-router.module';
import { ChatModule } from '../../modules/chat/chat.module';
import { UsersModule } from '../../modules/users/users.module';
import { WorkspaceModule } from '../../gateway/workspace/workspace.module';

@Module({
  imports: [
    ChannelsModule,
    ProvidersModule,
    forwardRef(() => SkillsModule),
    ModelRouterModule,
    ChatModule,
    UsersModule,
    WorkspaceModule,
  ],
  providers: [
    PipelineService,
    ReceiveStep,
    PreprocessStep,
    RouteStep,
    AgentRunStep,
    DeliverStep,
  ],
  exports: [PipelineService, ModelRouterModule],
})
export class PipelineModule {}
