import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthJwtModule } from '../../common/auth-jwt.module';
import { OpenclawAgentsModule } from '../openclaw-agents/openclaw-agents.module';
import { AgentWorkflow } from './entities/agent-workflow.entity';
import { AgentWorkflowStep } from './entities/agent-workflow-step.entity';
import { AgentWorkflowRun } from './entities/agent-workflow-run.entity';
import { AgentWorkflowRunStep } from './entities/agent-workflow-run-step.entity';
import { AgentWorkflowsService } from './agent-workflows.service';
import { AgentWorkflowExecutorService } from './agent-workflow-executor.service';
import { AgentWorkflowQueueService } from './agent-workflow-queue.service';
import { AgentWorkflowCronService } from './agent-workflow-cron.service';
import { AgentWorkflowsController } from './agent-workflows.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AgentWorkflow,
      AgentWorkflowStep,
      AgentWorkflowRun,
      AgentWorkflowRunStep,
    ]),
    AuthJwtModule,
    OpenclawAgentsModule,
  ],
  controllers: [AgentWorkflowsController],
  providers: [
    AgentWorkflowExecutorService,
    AgentWorkflowQueueService,
    AgentWorkflowsService,
    AgentWorkflowCronService,
  ],
  exports: [AgentWorkflowsService],
})
export class AgentWorkflowsModule {}
