import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import {
  ScheduledTask,
  TaskStatus,
  TaskSource,
} from './entities/scheduled-task.entity';
import { PipelineService } from '../pipeline/pipeline.service';
import { GlobalConfigService } from '../../modules/global-config/global-config.service';
import { IInboundMessage } from '../channels/interfaces/channel.interface';

const DEFAULT_MAX_RETRIES_PER_TICK = 3;
const DEFAULT_MAX_CONSECUTIVE_FAILED_TICKS = 3;

export interface CreateTaskOptions {
  userId: number;
  code: string;
  name: string;
  description?: string;
  cronExpression: string;
  agentPrompt: string;
  allowedSkills?: string[];
  source?: TaskSource;
  maxRetries?: number;
  maxTokensPerRun?: number;
  maxModelTier?: string;
  timeoutMs?: number;
}

@Injectable()
export class ScheduledTasksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduledTasksService.name);
  private readonly runningTasks = new Map<string, boolean>();

  constructor(
    @InjectRepository(ScheduledTask)
    private readonly taskRepo: Repository<ScheduledTask>,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly globalConfigService: GlobalConfigService,
    @Inject(forwardRef(() => PipelineService))
    private readonly pipelineService: PipelineService,
  ) {}

  async onModuleInit() {
    await this.loadAndScheduleAll();
  }

  onModuleDestroy() {
    this.stopAll();
  }

  // ─── Global rules (owner thiết lập trong bảng config) ───────

  private async getMaxRetriesPerTick(): Promise<number> {
    const config = await this.globalConfigService.getConfig();
    const v = config?.schedulerMaxRetriesPerTick;
    return v != null && v > 0 ? v : DEFAULT_MAX_RETRIES_PER_TICK;
  }

  private async getMaxConsecutiveFailedTicks(): Promise<number> {
    const config = await this.globalConfigService.getConfig();
    const v = config?.schedulerMaxConsecutiveFailedTicks;
    return v != null && v > 0 ? v : DEFAULT_MAX_CONSECUTIVE_FAILED_TICKS;
  }

  // ─── CRUD ──────────────────────────────────────────────────

  async create(options: CreateTaskOptions): Promise<ScheduledTask> {
    const existing = await this.taskRepo.findOne({
      where: { code: options.code },
    });
    if (existing) {
      throw new Error(`Task with code "${options.code}" already exists`);
    }

    const task = this.taskRepo.create({
      userId: options.userId,
      code: options.code,
      name: options.name,
      description: options.description,
      cronExpression: options.cronExpression,
      agentPrompt: options.agentPrompt,
      allowedSkills: options.allowedSkills ?? null,
      source: options.source ?? TaskSource.AGENT,
      maxRetries: options.maxRetries ?? 3,
      maxTokensPerRun: options.maxTokensPerRun ?? 0,
      maxModelTier: options.maxModelTier ?? null,
      timeoutMs: options.timeoutMs ?? 120000,
    });

    const saved = await this.taskRepo.save(task);
    this.scheduleTask(saved);
    this.logger.log(`Task created: ${saved.code} (${saved.cronExpression})`);
    return saved;
  }

  async update(
    taskId: number,
    data: Partial<ScheduledTask>,
  ): Promise<ScheduledTask> {
    await this.taskRepo.update(taskId, data);
    const task = await this.taskRepo.findOne({ where: { id: taskId } });

    this.unscheduleTask(task.code);
    if (task.status === TaskStatus.ACTIVE) {
      this.scheduleTask(task);
    }

    return task;
  }

  async remove(taskId: number): Promise<void> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) return;

    this.unscheduleTask(task.code);
    await this.taskRepo.delete(taskId);
    this.logger.log(`Task removed: ${task.code}`);
  }

  async pause(taskId: number): Promise<ScheduledTask> {
    return this.update(taskId, { status: TaskStatus.PAUSED });
  }

  async resume(taskId: number): Promise<ScheduledTask> {
    return this.update(taskId, {
      status: TaskStatus.ACTIVE,
      consecutiveFailures: 0,
    });
  }

  async findByUser(userId: number): Promise<ScheduledTask[]> {
    return this.taskRepo.find({ where: { userId } });
  }

  async findByCode(code: string): Promise<ScheduledTask | null> {
    return this.taskRepo.findOne({ where: { code } });
  }

  async findAll(): Promise<ScheduledTask[]> {
    return this.taskRepo.find();
  }

  /**
   * Owner thiết lập quy tắc chung cho tất cả cron/heartbeat.
   * Áp dụng cho mọi user kể cả owner.
   */
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

    this.logger.log(
      `Global scheduler rules updated: maxRetriesPerTick=${maxRetriesPerTick}, ` +
      `maxConsecutiveFailedTicks=${maxConsecutiveFailedTicks}`,
    );

    return { maxRetriesPerTick, maxConsecutiveFailedTicks };
  }

  async getGlobalRules(): Promise<{
    maxRetriesPerTick: number;
    maxConsecutiveFailedTicks: number;
  }> {
    const maxRetriesPerTick = await this.getMaxRetriesPerTick();
    const maxConsecutiveFailedTicks = await this.getMaxConsecutiveFailedTicks();
    return { maxRetriesPerTick, maxConsecutiveFailedTicks };
  }

  // ─── Scheduling Engine ────────────────────────────────────

  private async loadAndScheduleAll(): Promise<void> {
    try {
      const tasks = await this.taskRepo.find({
        where: { status: TaskStatus.ACTIVE },
      });

      for (const task of tasks) {
        this.scheduleTask(task);
      }

      this.logger.log(`Loaded ${tasks.length} active scheduled tasks`);
    } catch (error) {
      this.logger.warn(`Could not load scheduled tasks: ${error.message}`);
    }
  }

  private scheduleTask(task: ScheduledTask): void {
    const jobName = `scheduled_${task.code}`;

    try {
      this.schedulerRegistry.getCronJob(jobName);
      return;
    } catch {
      // Job doesn't exist yet — good, create it
    }

    const job = new CronJob(
      task.cronExpression,
      () => this.executeTick(task.code),
      null,
      true,
      process.env.TZ ?? 'Asia/Ho_Chi_Minh',
    );

    this.schedulerRegistry.addCronJob(jobName, job);
    job.start();

    this.logger.debug(
      `Scheduled: ${task.code} → "${task.cronExpression}" (next: ${job.nextDate()?.toISO()})`,
    );
  }

  private unscheduleTask(code: string): void {
    const jobName = `scheduled_${code}`;
    try {
      this.schedulerRegistry.deleteCronJob(jobName);
    } catch {
      // Job doesn't exist — ignore
    }
  }

  private stopAll(): void {
    const jobs = this.schedulerRegistry.getCronJobs();
    jobs.forEach((job, name) => {
      if (name.startsWith('scheduled_')) {
        job.stop();
      }
    });
  }

  // ─── Task Execution (quy tắc chung: owner thiết lập trong config) ───

  /**
   * Quy tắc chung (áp dụng mọi user, kể cả owner):
   *
   * 1. Trong 1 lượt tick: thử tối đa N lần (N = cof_scheduler_max_retries_per_tick, mặc định 3)
   * 2. Nếu 1 trong N lần thành công → reset consecutiveFailures, kết thúc lượt
   * 3. Nếu cả N lần đều lỗi → bỏ qua lượt đó, chờ lượt tiếp theo (next cron tick)
   *    → tăng consecutiveFailures
   * 4. Nếu M lượt liên tiếp đều fail (M = cof_scheduler_max_consecutive_failed_ticks, mặc định 3)
   *    → tự đóng task (auto-pause), owner phải resume thủ công
   */
  private async executeTick(taskCode: string): Promise<void> {
    if (this.runningTasks.get(taskCode)) {
      this.logger.debug(`Task ${taskCode}: already running, skipping tick`);
      return;
    }

    const task = await this.taskRepo.findOne({ where: { code: taskCode } });
    if (!task || task.status !== TaskStatus.ACTIVE) {
      return;
    }

    const maxRetriesPerTick = await this.getMaxRetriesPerTick();
    const maxConsecutiveFailedTicks = await this.getMaxConsecutiveFailedTicks();

    // Circuit breaker: đã fail M lượt liên tiếp → tự đóng
    if (task.consecutiveFailures >= maxConsecutiveFailedTicks) {
      this.logger.warn(
        `Task ${taskCode}: ${task.consecutiveFailures}/${maxConsecutiveFailedTicks} consecutive failed ticks → auto-disabling`,
      );
      await this.taskRepo.update(task.id, {
        status: TaskStatus.PAUSED,
        lastError: `Auto-disabled after ${task.consecutiveFailures} consecutive failed ticks`,
      });
      this.unscheduleTask(taskCode);
      return;
    }

    this.runningTasks.set(taskCode, true);
    const startedAt = Date.now();

    let lastError: Error | null = null;

    // Trong 1 lượt: thử tối đa maxRetriesPerTick lần
    for (let attempt = 1; attempt <= maxRetriesPerTick; attempt++) {
      this.logger.debug(
        `Task ${taskCode}: tick attempt ${attempt}/${maxRetriesPerTick}`,
      );

      try {
        const result = await this.executeWithTimeout(task);

        // Thành công → reset, kết thúc
        await this.taskRepo.update(task.id, {
          consecutiveFailures: 0,
          totalSuccesses: task.totalSuccesses + 1,
          lastRunAt: new Date(),
          lastSuccessAt: new Date(),
          lastError: null,
        });

        this.logger.log(
          `Task ${taskCode}: success in ${Date.now() - startedAt}ms ` +
          `(attempt ${attempt}, tokens: ${result.tokensUsed ?? 0})`,
        );
        this.runningTasks.delete(taskCode);
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `Task ${taskCode}: attempt ${attempt}/${maxRetriesPerTick} failed: ${error.message}`,
        );
      }
    }

    // Cả N lần đều lỗi → bỏ qua lượt này, tăng consecutiveFailures
    const newConsecutiveFailures = task.consecutiveFailures + 1;
    const shouldDisable = newConsecutiveFailures >= maxConsecutiveFailedTicks;

    await this.taskRepo.update(task.id, {
      consecutiveFailures: newConsecutiveFailures,
      totalFailures: task.totalFailures + 1,
      lastRunAt: new Date(),
      lastError: lastError?.message ?? 'Unknown error',
      status: shouldDisable ? TaskStatus.PAUSED : task.status,
    });

    if (shouldDisable) {
      this.unscheduleTask(taskCode);
      this.logger.error(
        `Task ${taskCode}: AUTO-DISABLED after ${newConsecutiveFailures} consecutive failed ticks. ` +
        `Last error: ${lastError?.message}. Owner must resume manually.`,
      );
    } else {
      this.logger.warn(
        `Task ${taskCode}: tick failed after ${maxRetriesPerTick} attempts ` +
        `(${newConsecutiveFailures}/${maxConsecutiveFailedTicks} consecutive). ` +
        `Skipping to next cron tick.`,
      );
    }

    this.runningTasks.delete(taskCode);
  }

  private async executeWithTimeout(
    task: ScheduledTask,
  ): Promise<{ tokensUsed: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      task.timeoutMs,
    );

    try {
      const inboundMessage: IInboundMessage = {
        channelId: 'scheduler',
        senderId: String(task.userId),
        content: task.agentPrompt,
        timestamp: new Date(),
      };

      const context = await this.pipelineService.processMessage(
        inboundMessage,
        {
          userId: task.userId,
          threadId: `task:${task.code}`,
          skills: task.allowedSkills ?? undefined,
        },
      );

      if (context.error) {
        throw context.error;
      }

      return { tokensUsed: context.tokensUsed ?? 0 };
    } finally {
      clearTimeout(timeout);
    }
  }
}
