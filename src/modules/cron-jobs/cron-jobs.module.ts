import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthJwtModule } from '../../common/auth-jwt.module';
import { CronJob } from './entities/cron-job.entity';
import { CronJobsService } from './cron-jobs.service';
import { CronJobsController } from './cron-jobs.controller';
import { TasksModule } from '../tasks/tasks.module';
import { TaskWorkflowsModule } from '../task-workflows/task-workflows.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CronJob]),
    AuthJwtModule,
    TasksModule,
    TaskWorkflowsModule,
  ],
  controllers: [CronJobsController],
  providers: [CronJobsService],
  exports: [CronJobsService],
})
export class CronJobsModule {}
