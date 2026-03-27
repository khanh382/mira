import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Workflow } from './entities/workflow.entity';
import { WorkflowNode } from './entities/workflow-node.entity';
import { WorkflowEdge } from './entities/workflow-edge.entity';
import { WorkflowRun } from './entities/workflow-run.entity';
import { WorkflowNodeRun } from './entities/workflow-node-run.entity';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowTemplateService } from './workflow-template.service';
import { WorkflowConditionService } from './workflow-condition.service';
import { WorkflowController } from './workflow.controller';
import { ProvidersModule } from '../providers/providers.module';
import { SkillsModule } from '../skills/skills.module';
import { ModelRouterModule } from '../pipeline/model-router/model-router.module';
import { GlobalConfigModule } from '../../modules/global-config/global-config.module';
import { UsersModule } from '../../modules/users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Workflow,
      WorkflowNode,
      WorkflowEdge,
      WorkflowRun,
      WorkflowNodeRun,
    ]),
    ProvidersModule,
    SkillsModule,
    ModelRouterModule,
    GlobalConfigModule,
    UsersModule,
  ],
  providers: [
    WorkflowEngineService,
    WorkflowTemplateService,
    WorkflowConditionService,
  ],
  controllers: [WorkflowController],
  exports: [WorkflowEngineService],
})
export class WorkflowModule {}
