import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthJwtModule } from '../../common/auth-jwt.module';
import { Workflow } from './entities/workflow.entity';
import { WorkflowTask } from './entities/workflow-task.entity';
import { WorkflowRun } from './entities/workflow-run.entity';
import { WorkflowRunTask } from './entities/workflow-run-task.entity';
import { TasksModule } from '../tasks/tasks.module';
import { TaskWorkflowsService } from './task-workflows.service';
import { TaskWorkflowExecutorService } from './task-workflow-executor.service';
import { TaskWorkflowQueueService } from './task-workflow-queue.service';
import { TaskWorkflowsController } from './task-workflows.controller';
import { TaskRun } from '../tasks/entities/task-run.entity';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Workflow, WorkflowTask, WorkflowRun, WorkflowRunTask, TaskRun]),
    AuthJwtModule,
    forwardRef(() => TasksModule),
    UsersModule,
  ],
  controllers: [TaskWorkflowsController],
  providers: [
    TaskWorkflowsService,
    TaskWorkflowExecutorService,
    TaskWorkflowQueueService,
  ],
  exports: [TaskWorkflowsService],
})
export class TaskWorkflowsModule {}
