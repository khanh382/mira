import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentRun } from './entities/agent-run.entity';
import { AgentFeedbackService } from './agent-feedback.service';
import { UsersModule } from '../../modules/users/users.module';
import { ModelPolicyModule } from '../model-policy/model-policy.module';

@Module({
  imports: [TypeOrmModule.forFeature([AgentRun]), UsersModule, ModelPolicyModule],
  providers: [AgentFeedbackService],
  exports: [AgentFeedbackService, TypeOrmModule],
})
export class AgentFeedbackModule {}

