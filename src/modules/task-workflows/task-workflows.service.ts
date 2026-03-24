import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Workflow } from './entities/workflow.entity';
import { WorkflowTask, WfTaskOnFailure } from './entities/workflow-task.entity';
import { WorkflowRun, WorkflowRunStatus, WorkflowRunTrigger } from './entities/workflow-run.entity';
import { WorkflowRunTask, WorkflowRunTaskStatus } from './entities/workflow-run-task.entity';
import {
  CreateWorkflowDto,
  UpdateWorkflowDto,
  ReplaceWorkflowTasksDto,
  WorkflowTaskInputDto,
  AddWorkflowTaskDto,
  PatchWorkflowTaskDto,
} from './dto/workflow.dto';
import { TaskWorkflowQueueService } from './task-workflow-queue.service';
import { TasksService } from '../tasks/tasks.service';

@Injectable()
export class TaskWorkflowsService {
  constructor(
    @InjectRepository(Workflow)
    private readonly wfRepo: Repository<Workflow>,
    @InjectRepository(WorkflowTask)
    private readonly wfTaskRepo: Repository<WorkflowTask>,
    @InjectRepository(WorkflowRun)
    private readonly runRepo: Repository<WorkflowRun>,
    @InjectRepository(WorkflowRunTask)
    private readonly runTaskRepo: Repository<WorkflowRunTask>,
    private readonly queue: TaskWorkflowQueueService,
    private readonly tasksService: TasksService,
  ) {}

  async create(userId: number, dto: CreateWorkflowDto): Promise<Workflow> {
    if (!dto.name?.trim()) {
      throw new BadRequestException('name là bắt buộc.');
    }
    if (!Array.isArray(dto.tasks) || !dto.tasks.length) {
      throw new BadRequestException('Workflow cần ít nhất một task.');
    }
    await this.assertTasksOwnedByUser(userId, dto.tasks);

    const wf = this.wfRepo.create({
      userId,
      name: dto.name.trim(),
      description: dto.description?.trim() ?? null,
      enabled: dto.enabled ?? true,
    });
    const saved = await this.wfRepo.save(wf);
    await this.persistWorkflowTasks(saved.id, dto.tasks);
    return this.findOneForUser(saved.id, userId);
  }

  async update(id: number, userId: number, dto: UpdateWorkflowDto): Promise<Workflow> {
    const wf = await this.requireOwnedWorkflow(id, userId);
    if (dto.name !== undefined) wf.name = dto.name.trim();
    if (dto.description !== undefined) wf.description = dto.description?.trim() ?? null;
    if (dto.enabled !== undefined) wf.enabled = dto.enabled;
    await this.wfRepo.save(wf);
    return this.findOneForUser(id, userId);
  }

  async replaceTasks(id: number, userId: number, dto: ReplaceWorkflowTasksDto): Promise<Workflow> {
    await this.requireOwnedWorkflow(id, userId);
    if (!Array.isArray(dto.tasks) || !dto.tasks.length) {
      throw new BadRequestException('Workflow cần ít nhất một task.');
    }
    await this.assertTasksOwnedByUser(userId, dto.tasks);
    await this.wfTaskRepo.delete({ workflowId: id });
    await this.persistWorkflowTasks(id, dto.tasks);
    return this.findOneForUser(id, userId);
  }

  async remove(id: number, userId: number): Promise<void> {
    const wf = await this.requireOwnedWorkflow(id, userId);
    wf.enabled = false;
    await this.wfRepo.save(wf);
  }

  async list(userId: number): Promise<Workflow[]> {
    return this.wfRepo.find({
      where: { userId },
      order: { id: 'ASC' },
      relations: ['workflowTasks'],
    });
  }

  async findOneForUser(id: number, userId: number): Promise<Workflow> {
    const wf = await this.wfRepo.findOne({
      where: { id, userId },
      relations: ['workflowTasks', 'workflowTasks.task'],
    });
    if (!wf) throw new NotFoundException('Workflow không tồn tại.');
    wf.workflowTasks?.sort((a, b) => a.taskOrder - b.taskOrder);
    return wf;
  }

  async enqueueRunForUser(wfId: number, userId: number): Promise<{ runId: string }> {
    const wf = await this.wfRepo.findOne({ where: { id: wfId, userId } });
    if (!wf) throw new NotFoundException('Workflow không tồn tại.');
    if (!wf.enabled) throw new BadRequestException('Workflow đang tắt (enabled=false).');
    return this.createRunAndEnqueue(wf.id, userId, WorkflowRunTrigger.MANUAL);
  }

  async enqueueRunFromCron(wfId: number): Promise<{ runId: string } | null> {
    const wf = await this.wfRepo.findOne({ where: { id: wfId } });
    if (!wf || !wf.enabled) return null;
    return this.createRunAndEnqueue(wf.id, wf.userId, WorkflowRunTrigger.CRON);
  }

  async listRuns(userId: number, workflowId?: number): Promise<WorkflowRun[]> {
    const where: { userId: number; workflowId?: number } = { userId };
    if (workflowId !== undefined) {
      const wf = await this.wfRepo.findOne({ where: { id: workflowId, userId } });
      if (!wf) throw new NotFoundException('Workflow không tồn tại.');
      where.workflowId = workflowId;
    }
    return this.runRepo.find({ where, order: { createdAt: 'DESC' }, take: 200 });
  }

  async getRunForUser(runId: string, userId: number): Promise<WorkflowRun> {
    const run = await this.runRepo.findOne({
      where: { id: runId, userId },
      relations: ['workflow', 'runTasks'],
    });
    if (!run) throw new NotFoundException('Không tìm thấy lần chạy.');
    run.runTasks?.sort((a, b) => a.taskOrder - b.taskOrder);
    return run;
  }

  async createRunAndEnqueue(
    workflowId: number,
    userId: number,
    trigger: WorkflowRunTrigger,
  ): Promise<{ runId: string }> {
    const wfTasks = await this.wfTaskRepo.find({
      where: { workflowId },
      order: { taskOrder: 'ASC' },
    });
    if (!wfTasks.length) {
      throw new BadRequestException('Workflow chưa có task nào.');
    }

    const runId = uuidv4();
    const run = this.runRepo.create({
      id: runId,
      workflowId,
      userId,
      status: WorkflowRunStatus.PENDING,
      trigger,
      currentTaskOrder: 0,
    });
    await this.runRepo.save(run);

    for (const wt of wfTasks) {
      const row = this.runTaskRepo.create({
        id: uuidv4(),
        workflowRunId: runId,
        taskId: wt.taskId,
        taskOrder: wt.taskOrder,
        status: WorkflowRunTaskStatus.PENDING,
      });
      await this.runTaskRepo.save(row);
    }

    try {
      await this.queue.enqueueRun(runId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.runRepo.update(runId, {
        status: WorkflowRunStatus.FAILED,
        error: `Queue error: ${msg}`.slice(0, 8000),
        finishedAt: new Date(),
      });
      throw new ServiceUnavailableException(
        'Không đưa được job vào hàng đợi. Kiểm tra REDIS_*.',
      );
    }

    return { runId };
  }

  /** Thêm 1 task vào workflow tại vị trí chỉ định, tự shift order các task sau lên. */
  async addTask(wfId: number, userId: number, dto: AddWorkflowTaskDto): Promise<Workflow> {
    await this.requireOwnedWorkflow(wfId, userId);
    await this.assertTasksOwnedByUser(userId, [{ taskId: dto.taskId, taskOrder: 0 }]);

    const existing = await this.wfTaskRepo.find({
      where: { workflowId: wfId },
      order: { taskOrder: 'ASC' },
    });

    // Xác định vị trí chèn: sau insertAfterOrder, hoặc cuối nếu không truyền.
    const insertAt =
      dto.insertAfterOrder !== undefined ? dto.insertAfterOrder + 1 : existing.length;

    // Shift tất cả task có order >= insertAt lên 1.
    const toShift = existing.filter((t) => t.taskOrder >= insertAt);
    for (const t of toShift) {
      await this.wfTaskRepo.update(t.id, { taskOrder: t.taskOrder + 1 });
    }

    await this.wfTaskRepo.save(
      this.wfTaskRepo.create({
        workflowId: wfId,
        taskId: dto.taskId,
        taskOrder: insertAt,
        onFailure: dto.onFailure ?? WfTaskOnFailure.STOP,
      }),
    );

    return this.findOneForUser(wfId, userId);
  }

  /** Xoá 1 workflow-task entry theo wtId, tự compact lại order. */
  async removeTask(wfId: number, userId: number, wtId: number): Promise<Workflow> {
    await this.requireOwnedWorkflow(wfId, userId);

    const target = await this.wfTaskRepo.findOne({ where: { id: wtId, workflowId: wfId } });
    if (!target) throw new NotFoundException('Workflow task không tồn tại.');

    const total = await this.wfTaskRepo.count({ where: { workflowId: wfId } });
    if (total <= 1) throw new BadRequestException('Workflow phải có ít nhất 1 task.');

    await this.wfTaskRepo.delete(wtId);

    // Compact order: các task sau vị trí bị xoá giảm 1.
    const after = await this.wfTaskRepo.find({
      where: { workflowId: wfId },
      order: { taskOrder: 'ASC' },
    });
    for (let i = 0; i < after.length; i++) {
      if (after[i].taskOrder !== i) {
        await this.wfTaskRepo.update(after[i].id, { taskOrder: i });
      }
    }

    return this.findOneForUser(wfId, userId);
  }

  /** Cập nhật 1 workflow-task entry: đổi task (swap), đổi onFailure, hoặc reorder (drag-drop). */
  async patchTask(wfId: number, userId: number, wtId: number, dto: PatchWorkflowTaskDto): Promise<Workflow> {
    await this.requireOwnedWorkflow(wfId, userId);

    const target = await this.wfTaskRepo.findOne({ where: { id: wtId, workflowId: wfId } });
    if (!target) throw new NotFoundException('Workflow task không tồn tại.');

    if (dto.taskId !== undefined && dto.taskId !== target.taskId) {
      await this.assertTasksOwnedByUser(userId, [{ taskId: dto.taskId, taskOrder: 0 }]);
      target.taskId = dto.taskId;
    }

    if (dto.onFailure !== undefined) {
      target.onFailure = dto.onFailure;
    }

    if (dto.taskOrder !== undefined && dto.taskOrder !== target.taskOrder) {
      const all = await this.wfTaskRepo.find({
        where: { workflowId: wfId },
        order: { taskOrder: 'ASC' },
      });
      const maxOrder = all.length - 1;
      const newOrder = Math.max(0, Math.min(dto.taskOrder, maxOrder));
      const oldOrder = target.taskOrder;

      // Shift các task nằm giữa oldOrder và newOrder.
      if (newOrder > oldOrder) {
        for (const t of all) {
          if (t.id !== wtId && t.taskOrder > oldOrder && t.taskOrder <= newOrder) {
            await this.wfTaskRepo.update(t.id, { taskOrder: t.taskOrder - 1 });
          }
        }
      } else {
        for (const t of all) {
          if (t.id !== wtId && t.taskOrder >= newOrder && t.taskOrder < oldOrder) {
            await this.wfTaskRepo.update(t.id, { taskOrder: t.taskOrder + 1 });
          }
        }
      }
      target.taskOrder = newOrder;
    }

    await this.wfTaskRepo.save(target);
    return this.findOneForUser(wfId, userId);
  }

  private async requireOwnedWorkflow(id: number, userId: number): Promise<Workflow> {
    const wf = await this.wfRepo.findOne({ where: { id, userId } });
    if (!wf) throw new NotFoundException('Workflow không tồn tại.');
    return wf;
  }

  private async assertTasksOwnedByUser(
    userId: number,
    tasks: WorkflowTaskInputDto[],
  ): Promise<void> {
    for (const t of tasks) {
      try {
        await this.tasksService.findOneForUser(t.taskId, userId);
      } catch {
        throw new BadRequestException(
          `Task id=${t.taskId} không thuộc tài khoản hoặc không tồn tại.`,
        );
      }
    }
  }

  private async persistWorkflowTasks(
    workflowId: number,
    tasks: WorkflowTaskInputDto[],
  ): Promise<void> {
    const sorted = [...tasks].sort((a, b) => a.taskOrder - b.taskOrder);
    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i];
      const row = this.wfTaskRepo.create({
        workflowId,
        taskId: t.taskId,
        taskOrder: i,
        onFailure: t.onFailure ?? WfTaskOnFailure.STOP,
      });
      await this.wfTaskRepo.save(row);
    }
  }
}
