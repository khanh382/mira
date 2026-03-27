import { Module } from '@nestjs/common';
import { PipelineModule } from '../../agent/pipeline/pipeline.module';
import { UsersModule } from '../../modules/users/users.module';
import { N8nModule } from './n8n.module';
import { N8nBrainController } from './n8n-brain.controller';

/**
 * n8n brain endpoint depends on PipelineModule.
 * Keep it separate from N8nModule (core) to avoid circular deps:
 * PipelineModule -> SkillsModule -> N8nModule
 */
@Module({
  imports: [N8nModule, UsersModule, PipelineModule],
  controllers: [N8nBrainController],
})
export class N8nBrainModule {}

