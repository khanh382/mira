import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Interval, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob as CronJobScheduler } from 'cron';
import { CronJob, CronJobTargetType } from './entities/cron-job.entity';
import { CreateCronJobDto, UpdateCronJobDto } from './dto/cron-job.dto';
import { TasksService } from '../tasks/tasks.service';
import { TaskWorkflowsService } from '../task-workflows/task-workflows.service';

@Injectable()
export class CronJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CronJobsService.name);
  private readonly running = new Map<number, boolean>();
  private readonly snapshots = new Map<number, string>();

  constructor(
    @InjectRepository(CronJob)
    private readonly repo: Repository<CronJob>,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly tasksService: TasksService,
    private readonly workflowsService: TaskWorkflowsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadAndScheduleAll();
  }

  onModuleDestroy(): void {
    this.stopAll();
  }

  // ─── CRUD ─────────────────────────────────────────────────────

  async create(userId: number, dto: CreateCronJobDto): Promise<CronJob> {
    if (!dto.name?.trim()) throw new BadRequestException('name là bắt buộc.');
    if (!dto.cronExpression?.trim())
      throw new BadRequestException('cronExpression là bắt buộc.');
    if (!dto.targetType || !dto.targetId)
      throw new BadRequestException('targetType và targetId là bắt buộc.');

    const job = this.repo.create({
      userId,
      name: dto.name.trim(),
      cronExpression: dto.cronExpression.trim(),
      targetType: dto.targetType,
      targetId: dto.targetId,
      enabled: dto.enabled ?? true,
      maxConsecutiveFailures: dto.maxConsecutiveFailures ?? 3,
    });
    const saved = await this.repo.save(job);
    if (saved.enabled) {
      this.scheduleJob(saved);
    }
    return saved;
  }

  async update(id: number, userId: number, dto: UpdateCronJobDto): Promise<CronJob> {
    const job = await this.requireOwned(id, userId);
    if (dto.name !== undefined) job.name = dto.name.trim();
    if (dto.cronExpression !== undefined) job.cronExpression = dto.cronExpression.trim();
    if (dto.enabled !== undefined) job.enabled = dto.enabled;
    if (dto.maxConsecutiveFailures !== undefined)
      job.maxConsecutiveFailures = dto.maxConsecutiveFailures;
    await this.repo.save(job);

    this.unscheduleJob(job.id);
    if (job.enabled) {
      this.scheduleJob(job);
    }
    return job;
  }

  async remove(id: number, userId: number): Promise<void> {
    const job = await this.requireOwned(id, userId);
    this.unscheduleJob(job.id);
    await this.repo.delete(id);
  }

  async list(userId: number): Promise<CronJob[]> {
    return this.repo.find({ where: { userId }, order: { id: 'ASC' } });
  }

  async findOneForUser(id: number, userId: number): Promise<CronJob> {
    const job = await this.repo.findOne({ where: { id, userId } });
    if (!job) throw new NotFoundException('Cron job không tồn tại.');
    return job;
  }

  // ─── Scheduling Engine ────────────────────────────────────────

  private async loadAndScheduleAll(): Promise<void> {
    try {
      const jobs = await this.repo.find({ where: { enabled: true } });
      for (const job of jobs) {
        this.scheduleJob(job);
      }
      this.logger.log(`Loaded ${jobs.length} active cron jobs.`);
    } catch (e) {
      this.logger.warn(`Could not load cron jobs: ${(e as Error).message}`);
    }
  }

  @Interval(30_000)
  private async refreshFromDatabase(): Promise<void> {
    try {
      const activeJobs = await this.repo.find({ where: { enabled: true } });
      const activeById = new Map(activeJobs.map((j) => [j.id, j]));

      for (const id of [...this.snapshots.keys()]) {
        if (!activeById.has(id)) {
          this.unscheduleJob(id);
        }
      }

      for (const job of activeJobs) {
        const snap = this.buildSnapshot(job);
        const prev = this.snapshots.get(job.id);
        if (prev !== snap) {
          this.unscheduleJob(job.id);
          this.scheduleJob(job);
        }
      }
    } catch (e) {
      this.logger.warn(`Cron jobs refresh failed: ${(e as Error).message}`);
    }
  }

  private scheduleJob(job: CronJob): void {
    const jobName = `cron_job_${job.id}`;
    try {
      this.schedulerRegistry.getCronJob(jobName);
      return;
    } catch {
      // does not exist yet — create it
    }

    try {
      const cronJob = new CronJobScheduler(
        job.cronExpression,
        () => void this.executeTick(job.id),
        null,
        true,
        process.env.TZ ?? 'Asia/Ho_Chi_Minh',
      );
      this.schedulerRegistry.addCronJob(jobName, cronJob);
      cronJob.start();
      this.snapshots.set(job.id, this.buildSnapshot(job));
      this.logger.debug(
        `Scheduled cron job #${job.id} "${job.name}" → "${job.cronExpression}"`,
      );
    } catch (e) {
      this.logger.warn(
        `Failed to schedule cron job #${job.id}: ${(e as Error).message}`,
      );
    }
  }

  private unscheduleJob(id: number): void {
    const jobName = `cron_job_${id}`;
    try {
      this.schedulerRegistry.deleteCronJob(jobName);
    } catch {
      // ignore if not found
    }
    this.snapshots.delete(id);
  }

  private stopAll(): void {
    for (const id of [...this.snapshots.keys()]) {
      this.unscheduleJob(id);
    }
  }

  private buildSnapshot(job: CronJob): string {
    return [job.cronExpression, job.enabled, job.targetType, job.targetId].join('::');
  }

  // ─── Tick Execution ───────────────────────────────────────────

  private async executeTick(jobId: number): Promise<void> {
    if (this.running.get(jobId)) {
      this.logger.debug(`Cron job #${jobId}: already running, skipping tick.`);
      return;
    }

    const job = await this.repo.findOne({ where: { id: jobId } });
    if (!job || !job.enabled) return;

    if (job.consecutiveFailures >= job.maxConsecutiveFailures) {
      this.logger.warn(
        `Cron job #${jobId}: ${job.consecutiveFailures}/${job.maxConsecutiveFailures} consecutive failures → auto-disabling.`,
      );
      await this.repo.update(jobId, {
        enabled: false,
        lastError: `Auto-disabled after ${job.consecutiveFailures} consecutive failures.`,
      });
      this.unscheduleJob(jobId);
      return;
    }

    this.running.set(jobId, true);
    let error: string | null = null;

    try {
      if (job.targetType === CronJobTargetType.TASK) {
        await this.tasksService.enqueueRunFromCron(job.targetId);
      } else {
        await this.workflowsService.enqueueRunFromCron(job.targetId);
      }
      await this.repo.update(jobId, {
        consecutiveFailures: 0,
        lastRunAt: new Date(),
        lastError: null,
      });
      this.logger.debug(`Cron job #${jobId} "${job.name}" fired successfully.`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      const newFailures = job.consecutiveFailures + 1;
      const shouldDisable = newFailures >= job.maxConsecutiveFailures;
      await this.repo.update(jobId, {
        consecutiveFailures: newFailures,
        lastRunAt: new Date(),
        lastError: error.slice(0, 2000),
        ...(shouldDisable ? { enabled: false } : {}),
      });
      if (shouldDisable) {
        this.unscheduleJob(jobId);
        this.logger.error(
          `Cron job #${jobId} AUTO-DISABLED after ${newFailures} failures. Last: ${error}`,
        );
      } else {
        this.logger.warn(`Cron job #${jobId} tick failed (${newFailures}/${job.maxConsecutiveFailures}): ${error}`);
      }
    } finally {
      this.running.delete(jobId);
    }
  }

  private async requireOwned(id: number, userId: number): Promise<CronJob> {
    const job = await this.repo.findOne({ where: { id, userId } });
    if (!job) throw new NotFoundException('Cron job không tồn tại.');
    return job;
  }
}
