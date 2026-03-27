import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { N8nDispatch, N8nDispatchStatus } from './entities/n8n-dispatch.entity';

@Injectable()
export class N8nDispatchService {
  constructor(
    @InjectRepository(N8nDispatch)
    private readonly repo: Repository<N8nDispatch>,
  ) {}

  async findById(id: string): Promise<N8nDispatch | null> {
    return this.repo.findOne({ where: { id } });
  }

  async findByIdempotencyKey(args: {
    userId: number;
    idempotencyKey: string;
  }): Promise<N8nDispatch | null> {
    return this.repo.findOne({
      where: { userId: args.userId, idempotencyKey: args.idempotencyKey },
    });
  }

  async createPending(args: {
    userId: number;
    threadId: string | null;
    workflowKey: string;
    idempotencyKey: string;
    dispatchNonce?: string | null;
    notifyChannelId?: string | null;
    notifyTargetId?: string | null;
    requestSnapshot?: Record<string, unknown> | null;
  }): Promise<N8nDispatch> {
    const row = this.repo.create({
      userId: args.userId,
      threadId: args.threadId,
      workflowKey: args.workflowKey,
      idempotencyKey: args.idempotencyKey,
      status: N8nDispatchStatus.PENDING,
      dispatchNonce: args.dispatchNonce ?? null,
      notifyChannelId: args.notifyChannelId ?? null,
      notifyTargetId: args.notifyTargetId ?? null,
      requestSnapshot: args.requestSnapshot ?? null,
      startedAt: null,
      finishedAt: null,
      error: null,
      resultPreview: null,
      n8nExecutionId: null,
    });
    return this.repo.save(row);
  }

  async markRunning(args: {
    id: string;
    executionId?: string | null;
  }): Promise<void> {
    await this.repo.update(args.id, {
      status: N8nDispatchStatus.RUNNING,
      startedAt: new Date(),
      n8nExecutionId: args.executionId ?? null,
      error: null,
    });
  }

  async markSucceeded(args: {
    id: string;
    executionId?: string | null;
    resultPreview?: string | null;
  }): Promise<void> {
    await this.repo.update(args.id, {
      status: N8nDispatchStatus.SUCCEEDED,
      finishedAt: new Date(),
      n8nExecutionId: args.executionId ?? null,
      resultPreview: args.resultPreview ?? null,
      error: null,
    });
  }

  async markFailed(args: {
    id: string;
    executionId?: string | null;
    error: string;
  }): Promise<void> {
    await this.repo.update(args.id, {
      status: N8nDispatchStatus.FAILED,
      finishedAt: new Date(),
      n8nExecutionId: args.executionId ?? null,
      error: args.error.slice(0, 8000),
    });
  }
}

