import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduledTask } from './entities/scheduled-task.entity';
import { ScheduledTasksService } from './scheduled-tasks.service';
import { HeartbeatService } from './heartbeat.service';
import { PipelineModule } from '../pipeline/pipeline.module';
import { UsersModule } from '../../modules/users/users.module';
import { GlobalConfigModule } from '../../modules/global-config/global-config.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ScheduledTask]),
    forwardRef(() => PipelineModule),
    UsersModule,
    GlobalConfigModule,
  ],
  providers: [ScheduledTasksService, HeartbeatService],
  exports: [ScheduledTasksService, HeartbeatService],
})
export class SchedulerModule {}
