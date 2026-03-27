import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Interval, SchedulerRegistry } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { CronJob } from 'cron';
import {
  ScheduledTargetType,
  TaskSource,
  TaskStatus,
} from './entities/scheduled-task.entity';
import { WorkflowScheduledN8n } from './entities/workflow-scheduled-n8n.entity';
import { WorkflowScheduledSystem } from './entities/workflow-scheduled-system.entity';
import { IScheduledTaskRecord } from './interfaces/scheduled-task-record.interface';
import { GlobalConfigService } from '../../modules/global-config/global-config.service';
import { SystemScheduledTasksService } from './system-scheduled-tasks.service';
import { WorkflowScheduledTasksService } from './workflow-scheduled-tasks.service';

const DEFAULT_MAX_RETRIES_PER_TICK = 3;
const DEFAULT_MAX_CONSECUTIVE_FAILED_TICKS = 3;
const SYSTEM_JOB_PREFIX = 'scheduled_system_';
const WORKFLOW_JOB_PREFIX = 'scheduled_workflow_';

export interface CreateTaskOptions {
  userId: number;
  code: string;
  name: string;
  description?: string;
  cronExpression: string;
  targetType?: ScheduledTargetType;
  agentPrompt?: string | null;
  n8nWorkflowKey?: string | null;
  n8nPayload?: Record<string, unknown> | null;
  notifyChannelId?: string | null;
  notifyTargetId?: string | null;
  allowedSkills?: string[];
  source?: TaskSource;
  maxRetries?: number;
  maxTokensPerRun?: number;
  maxModelTier?: string;
  timeoutMs?: number;
}

type TaskEntity = WorkflowScheduledN8n | WorkflowScheduledSystem;

@Injectable()
export class ScheduledTasksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduledTasksService.name);
  private readonly runningSystemTasks = new Map<string, boolean>();
  private readonly runningWorkflowTasks = new Map<string, boolean>();
  private readonly systemSnapshots = new Map<string, string>();
  private readonly workflowSnapshots = new Map<string, string>();

  constructor(
    @InjectRepository(WorkflowScheduledN8n)
    private readonly n8nRepo: Repository<WorkflowScheduledN8n>,
    @InjectRepository(WorkflowScheduledSystem)
    private readonly systemRepo: Repository<WorkflowScheduledSystem>,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly globalConfigService: GlobalConfigService,
    private readonly systemTasks: SystemScheduledTasksService,
    private readonly workflowTasks: WorkflowScheduledTasksService,
  ) {}

  async onModuleInit() {
    await this.loadAndScheduleAll();
  }

  onModuleDestroy() {
    this.stopAll();
  }

  async create(options: CreateTaskOptions): Promise<IScheduledTaskRecord> {
    const existing = await this.findByCode(options.code);
    if (existing) {
      throw new Error(`Task with code "${options.code}" already exists`);
    }

    const type = options.targetType ?? ScheduledTargetType.N8N_WORKFLOW;
    const base = {
      userId: options.userId,
      code: options.code,
      name: options.name,
      description: options.description ?? null,
      cronExpression: options.cronExpression,
      source: options.source ?? TaskSource.AGENT,
      status: TaskStatus.ACTIVE,
      maxRetries: options.maxRetries ?? 3,
      maxTokensPerRun: options.maxTokensPerRun ?? 0,
      maxModelTier: options.maxModelTier ?? null,
      timeoutMs: options.timeoutMs ?? 120000,
      consecutiveFailures: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      autoPauseOnMaxRetries: true,
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: null,
      nextRunAt: null,
    };

    const saved =
      type === ScheduledTargetType.N8N_WORKFLOW
        ? await this.n8nRepo.save(
            this.n8nRepo.create({
              ...base,
              targetType: ScheduledTargetType.N8N_WORKFLOW,
              n8nWorkflowKey: options.n8nWorkflowKey ?? null,
              n8nPayload: options.n8nPayload ?? null,
              notifyChannelId: options.notifyChannelId ?? null,
              notifyTargetId: options.notifyTargetId ?? null,
            }),
          )
        : await this.systemRepo.save(
            this.systemRepo.create({
              ...base,
              targetType: ScheduledTargetType.AGENT_PROMPT,
              agentPrompt: options.agentPrompt ?? null,
              allowedSkills: options.allowedSkills ?? null,
            }),
          );

    const task = this.toRecord(saved);
    this.scheduleTask(task);
    this.logger.log(`Task created: ${task.code} (${task.cronExpression})`);
    return task;
  }

  async update(
    taskId: number,
    data: Partial<IScheduledTaskRecord>,
  ): Promise<IScheduledTaskRecord> {
    const found = await this.findById(taskId);
    if (!found) throw new Error(`Task id ${taskId} not found`);
    const prev = this.toRecord(found.entity);

    const nextType = data.targetType ?? prev.targetType;
    if (nextType !== prev.targetType) {
      await this.remove(taskId);
      return this.create({
        userId: prev.userId,
        code: data.code ?? prev.code,
        name: data.name ?? prev.name,
        description: data.description ?? prev.description ?? undefined,
        cronExpression: data.cronExpression ?? prev.cronExpression,
        targetType: nextType,
        agentPrompt: data.agentPrompt ?? prev.agentPrompt,
        n8nWorkflowKey: data.n8nWorkflowKey ?? prev.n8nWorkflowKey,
        n8nPayload: data.n8nPayload ?? prev.n8nPayload,
        notifyChannelId: data.notifyChannelId ?? prev.notifyChannelId,
        notifyTargetId: data.notifyTargetId ?? prev.notifyTargetId,
        allowedSkills: data.allowedSkills ?? prev.allowedSkills ?? undefined,
        source: data.source ?? prev.source,
        maxRetries: data.maxRetries ?? prev.maxRetries,
        maxTokensPerRun: data.maxTokensPerRun ?? prev.maxTokensPerRun,
        maxModelTier: data.maxModelTier ?? prev.maxModelTier ?? undefined,
        timeoutMs: data.timeoutMs ?? prev.timeoutMs,
      });
    }

    await found.repo.update(taskId, data as any);
    const updated = await this.findById(taskId);
    if (!updated) throw new Error(`Task id ${taskId} not found after update`);
    const task = this.toRecord(updated.entity);
    this.unscheduleTask(prev.code, prev.targetType);
    if (task.status === TaskStatus.ACTIVE) {
      this.scheduleTask(task);
    }
    return task;
  }

  async remove(taskId: number): Promise<void> {
    const found = await this.findById(taskId);
    if (!found) return;
    const task = this.toRecord(found.entity);
    this.unscheduleTask(task.code, task.targetType);
    await found.repo.delete(taskId);
    this.logger.log(`Task removed: ${task.code}`);
  }

  async pause(taskId: number): Promise<IScheduledTaskRecord> {
    return this.update(taskId, { status: TaskStatus.PAUSED });
  }

  async resume(taskId: number): Promise<IScheduledTaskRecord> {
    return this.update(taskId, {
      status: TaskStatus.ACTIVE,
      consecutiveFailures: 0,
    });
  }

  async findByUser(userId: number): Promise<IScheduledTaskRecord[]> {
    const [workflow, system] = await Promise.all([
      this.n8nRepo.find({ where: { userId } }),
      this.systemRepo.find({ where: { userId } }),
    ]);
    return [...workflow, ...system].map((t) => this.toRecord(t));
  }

  async findByCode(code: string): Promise<IScheduledTaskRecord | null> {
    const [workflow, system] = await Promise.all([
      this.n8nRepo.findOne({ where: { code } }),
      this.systemRepo.findOne({ where: { code } }),
    ]);
    if (workflow && system) {
      throw new Error(`Duplicate task_code "${code}" across scheduler tables`);
    }
    return workflow ? this.toRecord(workflow) : system ? this.toRecord(system) : null;
  }

  async findAll(): Promise<IScheduledTaskRecord[]> {
    const [workflow, system] = await Promise.all([
      this.n8nRepo.find(),
      this.systemRepo.find(),
    ]);
    return [...workflow, ...system].map((t) => this.toRecord(t));
  }

  async setGlobalRules(options: {
    maxRetriesPerTick?: number;
    maxConsecutiveFailedTicks?: number;
  }): Promise<{ maxRetriesPerTick: number; maxConsecutiveFailedTicks: number }> {
    const current = await this.getGlobalRules();
    const maxRetriesPerTick =
      options.maxRetriesPerTick ?? current.maxRetriesPerTick;
    const maxConsecutiveFailedTicks =
      options.maxConsecutiveFailedTicks ?? current.maxConsecutiveFailedTicks;

    await this.globalConfigService.updateConfig({
      schedulerMaxRetriesPerTick: maxRetriesPerTick,
      schedulerMaxConsecutiveFailedTicks: maxConsecutiveFailedTicks,
    });

    return { maxRetriesPerTick, maxConsecutiveFailedTicks };
  }

  async getGlobalRules(): Promise<{
    maxRetriesPerTick: number;
    maxConsecutiveFailedTicks: number;
  }> {
    const config = await this.globalConfigService.getConfig();
    return {
      maxRetriesPerTick:
        config?.schedulerMaxRetriesPerTick && config.schedulerMaxRetriesPerTick > 0
          ? config.schedulerMaxRetriesPerTick
          : DEFAULT_MAX_RETRIES_PER_TICK,
      maxConsecutiveFailedTicks:
        config?.schedulerMaxConsecutiveFailedTicks &&
        config.schedulerMaxConsecutiveFailedTicks > 0
          ? config.schedulerMaxConsecutiveFailedTicks
          : DEFAULT_MAX_CONSECUTIVE_FAILED_TICKS,
    };
  }

  private async loadAndScheduleAll(): Promise<void> {
    try {
      const tasks = await this.findActiveTasks();
      tasks.forEach((t) => this.scheduleTask(t, true));
      this.logger.log(`Loaded ${tasks.length} active scheduled tasks`);
    } catch (error) {
      this.logger.warn(`Could not load scheduled tasks: ${error.message}`);
    }
  }

  @Interval(30_000)
  private async refreshFromDatabase(): Promise<void> {
    try {
      const activeTasks = await this.findActiveTasks();
      const activeByCode = new Map(activeTasks.map((t) => [t.code, t]));

      for (const code of [
        ...this.systemSnapshots.keys(),
        ...this.workflowSnapshots.keys(),
      ]) {
        if (!activeByCode.has(code)) this.unscheduleTask(code);
      }

      for (const task of activeTasks) {
        const prev = this.getSnapshots(task.targetType).get(task.code);
        const snapshot = this.buildSnapshot(task);
        this.scheduleTask(task, prev !== snapshot);
      }
    } catch (error) {
      this.logger.warn(`Scheduled task refresh failed: ${error.message}`);
    }
  }

  private scheduleTask(task: IScheduledTaskRecord, force = false): void {
    const jobName = this.getJobName(task.code, task.targetType);
    const snapshots = this.getSnapshots(task.targetType);

    if (force) {
      this.unscheduleTask(task.code, task.targetType);
    } else {
      try {
        this.schedulerRegistry.getCronJob(jobName);
        snapshots.set(task.code, this.buildSnapshot(task));
        return;
      } catch {
        // continue create
      }
    }

    const job = new CronJob(
      task.cronExpression,
      () => this.executeTick(task.code, task.targetType),
      null,
      true,
      process.env.TZ ?? 'Asia/Ho_Chi_Minh',
    );
    this.schedulerRegistry.addCronJob(jobName, job);
    job.start();
    snapshots.set(task.code, this.buildSnapshot(task));
  }

  private unscheduleTask(code: string, targetType?: ScheduledTargetType): void {
    const types = targetType
      ? [targetType]
      : [ScheduledTargetType.AGENT_PROMPT, ScheduledTargetType.N8N_WORKFLOW];

    for (const type of types) {
      const jobName = this.getJobName(code, type);
      try {
        this.schedulerRegistry.deleteCronJob(jobName);
      } catch {}
      this.getSnapshots(type).delete(code);
      this.getRunningTasks(type).delete(code);
    }
  }

  private stopAll(): void {
    const jobs = this.schedulerRegistry.getCronJobs();
    jobs.forEach((job, name) => {
      if (name.startsWith(SYSTEM_JOB_PREFIX) || name.startsWith(WORKFLOW_JOB_PREFIX)) {
        job.stop();
      }
    });
    this.systemSnapshots.clear();
    this.workflowSnapshots.clear();
    this.runningSystemTasks.clear();
    this.runningWorkflowTasks.clear();
  }

  private async executeTick(
    taskCode: string,
    expectedType: ScheduledTargetType,
  ): Promise<void> {
    const running = this.getRunningTasks(expectedType);
    if (running.get(taskCode)) return;

    const task = await this.findByCode(taskCode);
    if (!task || task.status !== TaskStatus.ACTIVE || task.targetType !== expectedType) {
      return;
    }

    const { maxRetriesPerTick, maxConsecutiveFailedTicks } =
      await this.getGlobalRules();
    if (task.consecutiveFailures >= maxConsecutiveFailedTicks) {
      await this.update(task.id, {
        status: TaskStatus.PAUSED,
        lastError: `Auto-disabled after ${task.consecutiveFailures} consecutive failed ticks`,
      });
      this.unscheduleTask(taskCode, expectedType);
      return;
    }

    running.set(taskCode, true);
    let lastError: Error | null = null;
    try {
      for (let attempt = 1; attempt <= maxRetriesPerTick; attempt++) {
        try {
          const result = await this.executeWithTimeout(task);
          await this.update(task.id, {
            consecutiveFailures: 0,
            totalSuccesses: task.totalSuccesses + 1,
            lastRunAt: new Date(),
            lastSuccessAt: new Date(),
            lastError: null,
          });
          this.logger.log(
            `Task ${taskCode}: success (attempt ${attempt}, tokens: ${result.tokensUsed ?? 0})`,
          );
          return;
        } catch (error) {
          lastError = error;
        }
      }

      const newConsecutiveFailures = task.consecutiveFailures + 1;
      const shouldPause = newConsecutiveFailures >= maxConsecutiveFailedTicks;
      await this.update(task.id, {
        consecutiveFailures: newConsecutiveFailures,
        totalFailures: task.totalFailures + 1,
        lastRunAt: new Date(),
        lastError: lastError?.message ?? 'Unknown error',
        status: shouldPause ? TaskStatus.PAUSED : task.status,
      });
      if (shouldPause) {
        this.unscheduleTask(taskCode, expectedType);
      }
    } finally {
      running.delete(taskCode);
    }
  }

  private async executeWithTimeout(
    task: IScheduledTaskRecord,
  ): Promise<{ tokensUsed: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), task.timeoutMs);
    try {
      if (task.targetType === ScheduledTargetType.AGENT_PROMPT) {
        return this.systemTasks.executeTask(task);
      }
      return this.workflowTasks.executeTask(task);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async findActiveTasks(): Promise<IScheduledTaskRecord[]> {
    const [workflow, system] = await Promise.all([
      this.n8nRepo.find({ where: { status: TaskStatus.ACTIVE } }),
      this.systemRepo.find({ where: { status: TaskStatus.ACTIVE } }),
    ]);
    return [...workflow, ...system].map((t) => this.toRecord(t));
  }

  private async findById(taskId: number): Promise<{
    entity: TaskEntity;
    repo: Repository<TaskEntity>;
  } | null> {
    const [workflow, system] = await Promise.all([
      this.n8nRepo.findOne({ where: { id: taskId } }),
      this.systemRepo.findOne({ where: { id: taskId } }),
    ]);
    if (workflow && system) {
      throw new Error(
        `Ambiguous task id ${taskId} exists in both scheduler tables; use code-based operations`,
      );
    }
    if (workflow) return { entity: workflow, repo: this.n8nRepo as any };
    if (system) return { entity: system, repo: this.systemRepo as any };
    return null;
  }

  private toRecord(task: TaskEntity): IScheduledTaskRecord {
    const workflow = this.isWorkflowTask(task);
    return {
      id: task.id,
      userId: task.userId,
      code: task.code,
      name: task.name,
      description: task.description ?? null,
      cronExpression: task.cronExpression,
      targetType: task.targetType,
      agentPrompt: workflow ? null : task.agentPrompt ?? null,
      n8nWorkflowKey: workflow ? task.n8nWorkflowKey ?? null : null,
      n8nPayload: workflow ? task.n8nPayload ?? null : null,
      notifyChannelId: workflow ? task.notifyChannelId ?? null : null,
      notifyTargetId: workflow ? task.notifyTargetId ?? null : null,
      allowedSkills: workflow ? null : task.allowedSkills ?? null,
      source: task.source,
      status: task.status,
      maxRetries: task.maxRetries,
      consecutiveFailures: task.consecutiveFailures,
      totalFailures: task.totalFailures,
      totalSuccesses: task.totalSuccesses,
      autoPauseOnMaxRetries: task.autoPauseOnMaxRetries,
      maxTokensPerRun: task.maxTokensPerRun,
      maxModelTier: task.maxModelTier ?? null,
      timeoutMs: task.timeoutMs,
      lastRunAt: task.lastRunAt ?? null,
      lastSuccessAt: task.lastSuccessAt ?? null,
      lastError: task.lastError ?? null,
      nextRunAt: task.nextRunAt ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  private isWorkflowTask(task: TaskEntity): task is WorkflowScheduledN8n {
    return task.targetType === ScheduledTargetType.N8N_WORKFLOW;
  }

  private getJobName(code: string, targetType: ScheduledTargetType): string {
    return targetType === ScheduledTargetType.N8N_WORKFLOW
      ? `${WORKFLOW_JOB_PREFIX}${code}`
      : `${SYSTEM_JOB_PREFIX}${code}`;
  }

  private getSnapshots(targetType: ScheduledTargetType): Map<string, string> {
    return targetType === ScheduledTargetType.N8N_WORKFLOW
      ? this.workflowSnapshots
      : this.systemSnapshots;
  }

  private getRunningTasks(targetType: ScheduledTargetType): Map<string, boolean> {
    return targetType === ScheduledTargetType.N8N_WORKFLOW
      ? this.runningWorkflowTasks
      : this.runningSystemTasks;
  }

  private buildSnapshot(task: IScheduledTaskRecord): string {
    return [
      task.status,
      task.cronExpression,
      task.targetType,
      task.agentPrompt ?? '',
      task.n8nWorkflowKey ?? '',
      JSON.stringify(task.n8nPayload ?? {}),
      task.notifyChannelId ?? '',
      task.notifyTargetId ?? '',
    ].join('::');
  }
}
