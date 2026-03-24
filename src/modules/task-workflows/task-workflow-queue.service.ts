import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { TaskWorkflowExecutorService } from './task-workflow-executor.service';
import {
  getWorkflowRedisConnection,
  pingWorkflowRedis,
} from '../agent-workflows/workflow-redis.util';

export const TASK_WORKFLOW_RUN_QUEUE = 'task-workflow-runs';

@Injectable()
export class TaskWorkflowQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskWorkflowQueueService.name);

  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private useMemoryFallback = true;
  private readonly pendingRunIds: string[] = [];
  private draining = false;
  private retryInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: ConfigService,
    @Inject(forwardRef(() => TaskWorkflowExecutorService))
    private readonly executor: TaskWorkflowExecutorService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.bootstrapFromRedis();
    const retryMs = Number(this.config.get<string>('WORKFLOW_REDIS_RETRY_MS', '30000'));
    if (retryMs > 0) {
      this.retryInterval = setInterval(() => {
        void this.tryUpgradeToRedis();
      }, retryMs);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }
    await this.closeRedis();
  }

  async enqueueRun(runId: string): Promise<void> {
    if (!this.useMemoryFallback && this.queue) {
      await this.queue.add(
        'run',
        { runId },
        { jobId: runId, removeOnComplete: 100, removeOnFail: 80, attempts: 1 },
      );
      return;
    }
    this.pendingRunIds.push(runId);
    void this.drainMemory();
  }

  private async bootstrapFromRedis(): Promise<void> {
    const ok = await pingWorkflowRedis(this.config);
    if (!ok) {
      this.logger.warn('Redis không sẵn sàng — task-workflow queue dùng RAM.');
      this.useMemoryFallback = true;
      return;
    }
    try {
      await this.openRedisQueue();
      this.useMemoryFallback = false;
      this.logger.log('Task-workflow queue: Redis (BullMQ) đã kết nối.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Không khởi tạo BullMQ task-workflow queue (${msg}). Dùng RAM.`);
      this.useMemoryFallback = true;
    }
  }

  private async tryUpgradeToRedis(): Promise<void> {
    if (!this.useMemoryFallback) return;
    const ok = await pingWorkflowRedis(this.config);
    if (!ok) return;
    await this.waitForMemoryIdle();
    try {
      await this.openRedisQueue();
      this.useMemoryFallback = false;
      this.logger.log('Đã chuyển task-workflow queue từ RAM sang Redis.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Thử chuyển Redis thất bại: ${msg}`);
    }
  }

  private async waitForMemoryIdle(maxMs = 60000): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      await this.drainMemory();
      if (!this.draining && this.pendingRunIds.length === 0) return;
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  private async drainMemory(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pendingRunIds.length > 0) {
        const runId = this.pendingRunIds.shift()!;
        await this.runOneJob(runId);
      }
    } finally {
      this.draining = false;
    }
  }

  private async runOneJob(runId: string): Promise<void> {
    try {
      await this.executor.executeRun(runId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Workflow run system error wfrId=${runId}: ${msg}`);
      await this.executor.markRunSystemFailure(runId, msg);
    }
  }

  private async openRedisQueue(): Promise<void> {
    await this.closeRedis();
    const connection = getWorkflowRedisConnection(this.config);
    this.queue = new Queue(TASK_WORKFLOW_RUN_QUEUE, { connection });
    this.worker = new Worker(
      TASK_WORKFLOW_RUN_QUEUE,
      async (job) => {
        const runId = job.data?.runId as string | undefined;
        if (!runId) return;
        await this.runOneJob(runId);
      },
      {
        connection,
        concurrency: Math.max(1, Number(this.config.get('WORKFLOW_CONCURRENCY', '2'))),
      },
    );
    this.worker.on('error', (err) => {
      this.logger.error(`Task-workflow BullMQ worker error: ${err.message}`);
    });
  }

  private async closeRedis(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
  }
}
