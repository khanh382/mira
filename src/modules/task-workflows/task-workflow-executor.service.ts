import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkflowRun, WorkflowRunStatus } from './entities/workflow-run.entity';
import { WorkflowRunTask, WorkflowRunTaskStatus } from './entities/workflow-run-task.entity';
import { WorkflowTask, WfTaskOnFailure } from './entities/workflow-task.entity';
import { TasksService } from '../tasks/tasks.service';
import { TaskRun, TaskRunStatus } from '../tasks/entities/task-run.entity';

@Injectable()
export class TaskWorkflowExecutorService {
  private readonly logger = new Logger(TaskWorkflowExecutorService.name);

  constructor(
    @InjectRepository(WorkflowRun)
    private readonly runRepo: Repository<WorkflowRun>,
    @InjectRepository(WorkflowRunTask)
    private readonly runTaskRepo: Repository<WorkflowRunTask>,
    @InjectRepository(WorkflowTask)
    private readonly wfTaskRepo: Repository<WorkflowTask>,
    @InjectRepository(TaskRun)
    private readonly taskRunRepo: Repository<TaskRun>,
    private readonly tasksService: TasksService,
  ) {}

  async executeRun(wfrId: string): Promise<void> {
    const run = await this.runRepo.findOne({ where: { id: wfrId } });
    if (!run) {
      this.logger.warn(`Workflow run not found: ${wfrId}`);
      return;
    }
    if (
      run.status === WorkflowRunStatus.COMPLETED ||
      run.status === WorkflowRunStatus.FAILED ||
      run.status === WorkflowRunStatus.CANCELLED
    ) {
      return;
    }

    const now = new Date();
    await this.runRepo.update(wfrId, {
      status: WorkflowRunStatus.RUNNING,
      startedAt: run.startedAt ?? now,
      error: null,
    });

    const runTasks = await this.runTaskRepo.find({
      where: { workflowRunId: wfrId },
      order: { taskOrder: 'ASC' },
    });

    let lastSummary = '';

    for (const runTask of runTasks) {
      if (runTask.status === WorkflowRunTaskStatus.COMPLETED) {
        continue;
      }
      if (runTask.status === WorkflowRunTaskStatus.SKIPPED) {
        continue;
      }
      if (runTask.status === WorkflowRunTaskStatus.FAILED) {
        await this.markRunFailed(wfrId, `Task order=${runTask.taskOrder} đã failed.`);
        return;
      }

      const wfTaskDef = await this.wfTaskRepo.findOne({
        where: { workflowId: run.workflowId, taskId: runTask.taskId },
      });
      const onFailure = wfTaskDef?.onFailure ?? WfTaskOnFailure.STOP;

      await this.runTaskRepo.update(runTask.id, {
        status: WorkflowRunTaskStatus.RUNNING,
        startedAt: new Date(),
      });
      await this.runRepo.update(wfrId, { currentTaskOrder: runTask.taskOrder });

      let taskRunId: string | null = null;
      let taskError: string | null = null;

      try {
        const result = await this.tasksService.enqueueRunFromWorkflow(
          runTask.taskId,
          run.userId,
        );
        taskRunId = result.runId;

        await this.runTaskRepo.update(runTask.id, { taskRunId });

        // Poll cho đến khi task run kết thúc
        const finalStatus = await this.waitForTaskRun(taskRunId);

        if (
          finalStatus === TaskRunStatus.FAILED ||
          finalStatus === TaskRunStatus.CANCELLED
        ) {
          const taskRun = await this.taskRunRepo.findOne({ where: { id: taskRunId } });
          taskError = taskRun?.error ?? `Task run kết thúc với status=${finalStatus}`;
        } else {
          const taskRun = await this.taskRunRepo.findOne({ where: { id: taskRunId } });
          lastSummary = taskRun?.summary ?? lastSummary;
        }
      } catch (e) {
        taskError = e instanceof Error ? e.message : String(e);
        this.logger.error(
          `Workflow run=${wfrId} task order=${runTask.taskOrder} error: ${taskError}`,
        );
      }

      if (taskError !== null) {
        const trimmed = taskError.slice(0, 8000);
        await this.runTaskRepo.update(runTask.id, {
          status: WorkflowRunTaskStatus.FAILED,
          error: trimmed,
          finishedAt: new Date(),
        });

        if (onFailure === WfTaskOnFailure.STOP) {
          await this.markRunFailed(wfrId, `Task order=${runTask.taskOrder} thất bại: ${trimmed}`);
          return;
        }
        if (onFailure === WfTaskOnFailure.SKIP) {
          await this.runTaskRepo.update(runTask.id, {
            status: WorkflowRunTaskStatus.SKIPPED,
          });
          continue;
        }
        // CONTINUE — ghi failed nhưng tiếp tục
        continue;
      }

      await this.runTaskRepo.update(runTask.id, {
        status: WorkflowRunTaskStatus.COMPLETED,
        finishedAt: new Date(),
      });
    }

    await this.runRepo.update(wfrId, {
      status: WorkflowRunStatus.COMPLETED,
      finishedAt: new Date(),
      error: null,
      summary: lastSummary || null,
    });
  }

  async markRunSystemFailure(wfrId: string, message: string): Promise<void> {
    const trimmed = message.slice(0, 8000);
    await this.runRepo.update(wfrId, {
      status: WorkflowRunStatus.FAILED,
      error: trimmed,
      finishedAt: new Date(),
      summary: trimmed.slice(0, 4000),
    });
  }

  /** Poll task run DB cho đến khi xong hoặc timeout (10 phút). */
  private async waitForTaskRun(
    taskRunId: string,
    maxMs = 600_000,
  ): Promise<TaskRunStatus> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const row = await this.taskRunRepo.findOne({
        where: { id: taskRunId },
        select: ['id', 'status'],
      });
      if (!row) return TaskRunStatus.FAILED;
      if (
        row.status === TaskRunStatus.COMPLETED ||
        row.status === TaskRunStatus.FAILED ||
        row.status === TaskRunStatus.CANCELLED
      ) {
        return row.status;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return TaskRunStatus.FAILED;
  }

  private async markRunFailed(wfrId: string, error: string): Promise<void> {
    const trimmed = error.slice(0, 8000);
    await this.runRepo.update(wfrId, {
      status: WorkflowRunStatus.FAILED,
      error: trimmed,
      finishedAt: new Date(),
      summary: trimmed.slice(0, 4000),
    });
  }
}
