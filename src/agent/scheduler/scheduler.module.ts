import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkflowScheduledN8n } from './entities/workflow-scheduled-n8n.entity';
import { WorkflowScheduledSystem } from './entities/workflow-scheduled-system.entity';
import { ScheduledTasksService } from './scheduled-tasks.service';
import { HeartbeatService } from './heartbeat.service';
import { SystemScheduledTasksService } from './system-scheduled-tasks.service';
import { WorkflowScheduledTasksService } from './workflow-scheduled-tasks.service';
import { PipelineModule } from '../pipeline/pipeline.module';
import { UsersModule } from '../../modules/users/users.module';
import { GlobalConfigModule } from '../../modules/global-config/global-config.module';
import { N8nModule } from '../../integrations/n8n/n8n.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([WorkflowScheduledN8n, WorkflowScheduledSystem]),
    forwardRef(() => PipelineModule),
    UsersModule,
    GlobalConfigModule,
    N8nModule,
  ],
  providers: [
    ScheduledTasksService,
    SystemScheduledTasksService,
    WorkflowScheduledTasksService,
    HeartbeatService,
  ],
  exports: [ScheduledTasksService, HeartbeatService],
})
export class SchedulerModule {}
