import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthJwtModule } from '../../common/auth-jwt.module';
import { OpenclawAgentsModule } from '../openclaw-agents/openclaw-agents.module';
import { PipelineModule } from '../../agent/pipeline/pipeline.module';
import { Task } from './entities/task.entity';
import { TaskStep } from './entities/task-step.entity';
import { TaskRun } from './entities/task-run.entity';
import { TaskRunStep } from './entities/task-run-step.entity';
import { TasksService } from './tasks.service';
import { TaskExecutorService } from './task-executor.service';
import { TaskQueueService } from './task-queue.service';
import { TasksController } from './tasks.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Task, TaskStep, TaskRun, TaskRunStep]),
    AuthJwtModule,
    OpenclawAgentsModule,
    forwardRef(() => PipelineModule),
  ],
  controllers: [TasksController],
  providers: [TasksService, TaskExecutorService, TaskQueueService],
  exports: [TasksService, TaskExecutorService],
})
export class TasksModule {}
