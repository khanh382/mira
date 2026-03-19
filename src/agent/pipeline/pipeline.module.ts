import { Module } from '@nestjs/common';
import { PipelineService } from './pipeline.service';
import { ReceiveStep } from './steps/receive.step';
import { PreprocessStep } from './steps/preprocess.step';
import { RouteStep } from './steps/route.step';
import { AgentRunStep } from './steps/agent-run.step';
import { DeliverStep } from './steps/deliver.step';
import { ChannelsModule } from '../channels/channels.module';
import { ProvidersModule } from '../providers/providers.module';
import { SkillsModule } from '../skills/skills.module';

@Module({
  imports: [ChannelsModule, ProvidersModule, SkillsModule],
  providers: [
    PipelineService,
    ReceiveStep,
    PreprocessStep,
    RouteStep,
    AgentRunStep,
    DeliverStep,
  ],
  exports: [PipelineService],
})
export class PipelineModule {}
