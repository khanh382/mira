import { Injectable } from '@nestjs/common';
import { IScheduledTaskRecord } from './interfaces/scheduled-task-record.interface';
import { N8nClientService } from '../../integrations/n8n/n8n-client.service';
import { N8nDispatchService } from '../../integrations/n8n/n8n-dispatch.service';
import { N8nDispatchStatus } from '../../integrations/n8n/entities/n8n-dispatch.entity';
import { IN8nDispatchRequestBody } from '../../integrations/n8n/n8n-contract';

@Injectable()
export class WorkflowScheduledTasksService {
  constructor(
    private readonly n8nClient: N8nClientService,
    private readonly n8nDispatches: N8nDispatchService,
  ) {}

  async executeTask(task: IScheduledTaskRecord): Promise<{ tokensUsed: number }> {
    const wfKey = String(task.n8nWorkflowKey ?? '').trim();
    if (!wfKey) {
      throw new Error('n8nWorkflowKey is required for targetType=n8n_workflow');
    }

    const dispatch = await this.dispatchAndWaitForN8n({
      userId: task.userId,
      workflowKey: wfKey,
      payload: task.n8nPayload ?? {},
      idempotencyKey: `sched:${task.userId}:${task.code}:${Date.now()}`,
      notify: {
        channelId: task.notifyChannelId,
        targetId: task.notifyTargetId,
      },
    });

    if (!dispatch.ok) {
      throw new Error(dispatch.error ?? 'n8n dispatch failed');
    }

    return { tokensUsed: 0 };
  }

  private getTaskPollIntervalMs(): number {
    const raw = Number(process.env.WORKFLOW_TASK_POLL_MS ?? '2000');
    if (!Number.isFinite(raw)) return 2000;
    return Math.min(60_000, Math.max(500, Math.floor(raw)));
  }

  private getCallbackUrlOrThrow(): string {
    const url = String(process.env.N8N_CALLBACK_URL ?? '').trim();
    if (!url) throw new Error('N8N_CALLBACK_URL is not configured');
    return url;
  }

  private async dispatchAndWaitForN8n(args: {
    userId: number;
    workflowKey: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    notify: { channelId: string | null; targetId: string | null };
  }): Promise<{ ok: boolean; dispatchId?: string; error?: string }> {
    const dispatch = await this.n8nDispatches.createPending({
      userId: args.userId,
      threadId: null,
      workflowKey: args.workflowKey,
      idempotencyKey: args.idempotencyKey,
      notifyChannelId: args.notify.channelId,
      notifyTargetId: args.notify.targetId,
      requestSnapshot: {
        workflowKey: args.workflowKey,
        idempotencyKey: args.idempotencyKey,
        payloadKeys: Object.keys(args.payload ?? {}).slice(0, 60),
      },
    });

    const body: IN8nDispatchRequestBody = {
      dispatchId: dispatch.id,
      workflowKey: args.workflowKey,
      idempotencyKey: args.idempotencyKey,
      userContext: { userId: args.userId },
      threadContext: { threadId: '' },
      payload: args.payload ?? {},
      callback: { url: this.getCallbackUrlOrThrow() },
    };

    const res = await this.n8nClient.dispatch(body);
    if (!res.ok) {
      await this.n8nDispatches.markFailed({
        id: dispatch.id,
        error: res.error ?? `HTTP ${res.status}`,
      });
      return {
        ok: false,
        dispatchId: dispatch.id,
        error: res.error ?? `HTTP ${res.status}`,
      };
    }

    await this.n8nDispatches.markRunning({
      id: dispatch.id,
      executionId:
        typeof (res.data as any)?.executionId === 'string'
          ? ((res.data as any).executionId as string)
          : null,
    });

    const pollMs = this.getTaskPollIntervalMs();
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const row = await this.n8nDispatches.findById(dispatch.id);
      if (!row) {
        return { ok: false, dispatchId: dispatch.id, error: 'dispatch not found' };
      }
      if (row.status === N8nDispatchStatus.SUCCEEDED) {
        return { ok: true, dispatchId: dispatch.id };
      }
      if (
        row.status === N8nDispatchStatus.FAILED ||
        row.status === N8nDispatchStatus.TIMED_OUT
      ) {
        return {
          ok: false,
          dispatchId: dispatch.id,
          error: row.error ?? `status=${row.status}`,
        };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    await this.n8nDispatches.markFailed({ id: dispatch.id, error: 'timeout' });
    return { ok: false, dispatchId: dispatch.id, error: 'timeout' };
  }
}
