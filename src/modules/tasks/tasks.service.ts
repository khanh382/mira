import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Task } from './entities/task.entity';
import { TaskStep, StepExecutorType } from './entities/task-step.entity';
import { TaskRun, TaskRunStatus, TaskRunTrigger } from './entities/task-run.entity';
import { TaskRunStep, TaskRunStepStatus } from './entities/task-run-step.entity';
import {
  CreateTaskDto,
  UpdateTaskDto,
  ReplaceTaskStepsDto,
  TaskStepInputDto,
} from './dto/task.dto';
import { TaskQueueService } from './task-queue.service';

@Injectable()
export class TasksService {
  constructor(
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
    @InjectRepository(TaskStep)
    private readonly stepRepo: Repository<TaskStep>,
    @InjectRepository(TaskRun)
    private readonly runRepo: Repository<TaskRun>,
    @InjectRepository(TaskRunStep)
    private readonly runStepRepo: Repository<TaskRunStep>,
    private readonly taskQueue: TaskQueueService,
  ) {}

  async create(userId: number, dto: CreateTaskDto): Promise<Task> {
    if (!dto.code?.trim()) {
      throw new BadRequestException('code là bắt buộc.');
    }
    if (!dto.name?.trim()) {
      throw new BadRequestException('name là bắt buộc.');
    }
    if (!Array.isArray(dto.steps) || !dto.steps.length) {
      throw new BadRequestException('Task cần ít nhất một bước (steps).');
    }

    const existing = await this.taskRepo.findOne({ where: { code: dto.code.trim() } });
    if (existing) {
      throw new BadRequestException(`Task code "${dto.code}" đã tồn tại.`);
    }

    this.validateSteps(dto.steps);

    const task = this.taskRepo.create({
      userId,
      code: dto.code.trim(),
      name: dto.name.trim(),
      description: dto.description?.trim() ?? null,
      enabled: dto.enabled ?? true,
    });
    const saved = await this.taskRepo.save(task);
    await this.persistSteps(saved.id, dto.steps);
    return this.findOneForUser(saved.id, userId);
  }

  async update(id: number, userId: number, dto: UpdateTaskDto): Promise<Task> {
    const task = await this.requireOwnedTask(id, userId);
    if (dto.name !== undefined) task.name = dto.name.trim();
    if (dto.description !== undefined) task.description = dto.description?.trim() ?? null;
    if (dto.enabled !== undefined) task.enabled = dto.enabled;
    await this.taskRepo.save(task);
    return this.findOneForUser(id, userId);
  }

  async replaceSteps(id: number, userId: number, dto: ReplaceTaskStepsDto): Promise<Task> {
    await this.requireOwnedTask(id, userId);
    if (!Array.isArray(dto.steps) || !dto.steps.length) {
      throw new BadRequestException('Task cần ít nhất một bước (steps).');
    }
    this.validateSteps(dto.steps);
    await this.stepRepo.delete({ taskId: id });
    await this.persistSteps(id, dto.steps);
    return this.findOneForUser(id, userId);
  }

  async remove(id: number, userId: number): Promise<void> {
    const task = await this.requireOwnedTask(id, userId);
    task.enabled = false;
    await this.taskRepo.save(task);
  }

  async list(userId: number): Promise<Task[]> {
    return this.taskRepo.find({
      where: { userId },
      order: { id: 'ASC' },
      relations: ['steps'],
    });
  }

  async findOneForUser(id: number, userId: number): Promise<Task> {
    const task = await this.taskRepo.findOne({
      where: { id, userId },
      relations: ['steps'],
    });
    if (!task) throw new NotFoundException('Task không tồn tại.');
    task.steps?.sort((a, b) => a.stepOrder - b.stepOrder);
    return task;
  }

  async enqueueRunForUser(
    taskId: number,
    userId: number,
  ): Promise<{ runId: string }> {
    const task = await this.taskRepo.findOne({ where: { id: taskId, userId } });
    if (!task) throw new NotFoundException('Task không tồn tại.');
    if (!task.enabled) throw new BadRequestException('Task đang tắt (enabled=false).');
    return this.createRunAndEnqueue(task.id, userId, TaskRunTrigger.MANUAL);
  }

  /** Gọi từ workflow executor — bỏ qua check userId ownership (đã kiểm tra ở tầng workflow). */
  async enqueueRunFromWorkflow(
    taskId: number,
    userId: number,
  ): Promise<{ runId: string }> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`Task id=${taskId} không tồn tại.`);
    if (!task.enabled) throw new BadRequestException(`Task "${task.code}" đang tắt.`);
    return this.createRunAndEnqueue(task.id, userId, TaskRunTrigger.WORKFLOW);
  }

  /** Gọi từ cron service. */
  async enqueueRunFromCron(taskId: number): Promise<{ runId: string } | null> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task || !task.enabled) return null;
    return this.createRunAndEnqueue(task.id, task.userId, TaskRunTrigger.CRON);
  }

  async listRuns(userId: number, taskId?: number): Promise<TaskRun[]> {
    const where: { userId: number; taskId?: number } = { userId };
    if (taskId !== undefined) {
      const task = await this.taskRepo.findOne({ where: { id: taskId, userId } });
      if (!task) throw new NotFoundException('Task không tồn tại.');
      where.taskId = taskId;
    }
    return this.runRepo.find({ where, order: { createdAt: 'DESC' }, take: 200 });
  }

  async getRunForUser(runId: string, userId: number): Promise<TaskRun> {
    const run = await this.runRepo.findOne({
      where: { id: runId, userId },
      relations: ['task', 'steps'],
    });
    if (!run) throw new NotFoundException('Không tìm thấy lần chạy.');
    run.steps?.sort((a, b) => a.stepIndex - b.stepIndex);
    return run;
  }

  async createRunAndEnqueue(
    taskId: number,
    userId: number,
    trigger: TaskRunTrigger,
  ): Promise<{ runId: string }> {
    const steps = await this.stepRepo.find({
      where: { taskId },
      order: { stepOrder: 'ASC' },
    });
    if (!steps.length) {
      throw new BadRequestException('Task chưa có bước (steps).');
    }

    const runId = uuidv4();
    const run = this.runRepo.create({
      id: runId,
      taskId,
      userId,
      status: TaskRunStatus.PENDING,
      trigger,
      currentStep: 0,
    });
    await this.runRepo.save(run);

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const row = this.runStepRepo.create({
        id: uuidv4(),
        runId,
        stepIndex: i,
        executorType: s.executorType,
        skillCode: s.skillCode,
        oaId: s.oaId,
        status: TaskRunStepStatus.PENDING,
        inputSnapshot: s.prompt,
        maxAttempts: s.retryCount + 1,
      });
      await this.runStepRepo.save(row);
    }

    try {
      await this.taskQueue.enqueueRun(runId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.runRepo.update(runId, {
        status: TaskRunStatus.FAILED,
        error: `Queue error: ${msg}`.slice(0, 8000),
        finishedAt: new Date(),
      });
      throw new ServiceUnavailableException(
        'Không đưa được job vào hàng đợi. Kiểm tra REDIS_*.',
      );
    }

    return { runId };
  }

  private async requireOwnedTask(id: number, userId: number): Promise<Task> {
    const task = await this.taskRepo.findOne({ where: { id, userId } });
    if (!task) throw new NotFoundException('Task không tồn tại.');
    return task;
  }

  private validateSteps(steps: TaskStepInputDto[]): void {
    for (const s of steps) {
      if (s.executorType === StepExecutorType.OPENCLAW && !s.oaId) {
        throw new BadRequestException(
          `Step "${s.name}" có executor_type=openclaw nhưng thiếu oaId.`,
        );
      }
      if (!s.prompt?.trim()) {
        throw new BadRequestException(`Step "${s.name}" thiếu prompt.`);
      }
    }
  }

  private async persistSteps(taskId: number, steps: TaskStepInputDto[]): Promise<void> {
    const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder);
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      const row = this.stepRepo.create({
        taskId,
        stepOrder: i,
        name: s.name,
        executorType: s.executorType ?? StepExecutorType.INTERNAL,
        skillCode: s.skillCode ?? null,
        oaId: s.oaId ?? null,
        prompt: s.prompt,
        retryCount: s.retryCount ?? 0,
        timeoutMs: s.timeoutMs ?? 120000,
        onFailure: s.onFailure ?? undefined,
      });
      await this.stepRepo.save(row);
    }
  }
}
