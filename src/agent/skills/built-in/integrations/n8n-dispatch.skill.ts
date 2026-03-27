import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { RegisterSkill } from '../../decorators/skill.decorator';
import {
  ISkillDefinition,
  ISkillExecutionContext,
  ISkillResult,
  ISkillRunner,
  SkillCategory,
  SkillType,
} from '../../interfaces/skill-runner.interface';
import { ModelTier } from '../../../pipeline/model-router/model-tier.enum';
import { UsersService } from '../../../../modules/users/users.service';
import { UserLevel } from '../../../../modules/users/entities/user.entity';
import { N8nClientService } from '../../../../integrations/n8n/n8n-client.service';
import { N8nDispatchService } from '../../../../integrations/n8n/n8n-dispatch.service';
import { IN8nDispatchRequestBody } from '../../../../integrations/n8n/n8n-contract';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    workflowKey: {
      type: 'string',
      description:
        'Workflow key (allowlisted) to execute inside the hidden n8n instance.',
    },
    payload: {
      type: 'object',
      description:
        'Minimal payload for the workflow. Never include secrets unless absolutely required.',
    },
    idempotencyKey: {
      type: 'string',
      description:
        'Optional idempotency key. If omitted, Mira will derive one from context.',
    },
    notify: {
      type: 'object',
      description:
        'Optional: how to notify the user when workflow completes. For webchat, targetId can be omitted.',
      properties: {
        channelId: {
          type: 'string',
          enum: ['telegram', 'discord', 'zalo', 'slack', 'webchat'],
        },
        targetId: { type: 'string' },
      },
    },
  },
  required: ['workflowKey', 'payload'],
};

@RegisterSkill({
  code: 'n8n_dispatch',
  name: 'Dispatch n8n Workflow',
  description:
    'Dispatch a hidden n8n workflow asynchronously. Use for integration-heavy tasks (fetch data, send mail, sync SaaS).',
  category: SkillCategory.CUSTOM,
  parametersSchema: PARAMETERS_SCHEMA,
  minModelTier: ModelTier.SKILL,
})
@Injectable()
export class N8nDispatchSkill implements ISkillRunner {
  private readonly logger = new Logger(N8nDispatchSkill.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly config: ConfigService,
    private readonly n8nClient: N8nClientService,
    private readonly dispatches: N8nDispatchService,
  ) {}

  get definition(): ISkillDefinition {
    return {
      code: 'n8n_dispatch',
      name: 'Dispatch n8n Workflow',
      description: 'Dispatch a hidden n8n workflow asynchronously',
      category: SkillCategory.CUSTOM,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
      minModelTier: ModelTier.SKILL,
    };
  }

  private parseAllowlist(raw: string | undefined | null): Set<string> {
    const s = String(raw ?? '').trim();
    if (!s) return new Set();
    return new Set(
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    );
  }

  private allowlistForLevel(level: UserLevel): Set<string> {
    const common = this.parseAllowlist(this.config.get('N8N_WORKFLOWS_COMMON'));
    const per =
      level === UserLevel.OWNER
        ? this.parseAllowlist(this.config.get('N8N_WORKFLOWS_OWNER'))
        : level === UserLevel.COLLEAGUE
          ? this.parseAllowlist(this.config.get('N8N_WORKFLOWS_COLLEAGUE'))
          : this.parseAllowlist(this.config.get('N8N_WORKFLOWS_CLIENT'));
    if (!common.size && !per.size) {
      // Default: disabled unless explicitly allowlisted.
      return new Set();
    }
    return new Set([...common, ...per]);
  }

  private deriveIdempotencyKey(args: {
    userId: number;
    threadId: string;
    workflowKey: string;
    payload: Record<string, unknown>;
    runId?: string;
  }): string {
    const basis = JSON.stringify({
      userId: args.userId,
      threadId: args.threadId,
      workflowKey: args.workflowKey,
      payload: args.payload,
      runId: args.runId ?? null,
    });
    const h = createHash('sha1').update(basis).digest('hex');
    return `n8n:${args.workflowKey}:${h}`;
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const workflowKey = String(context.parameters.workflowKey ?? '').trim();
    const payload = context.parameters.payload as Record<string, unknown>;

    if (!workflowKey) {
      return {
        success: false,
        error: 'workflowKey is required',
        metadata: { durationMs: Date.now() - start },
      };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {
        success: false,
        error: 'payload must be an object',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const user = await this.usersService.findById(context.userId);
    if (!user) {
      return {
        success: false,
        error: 'User not found',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const allowlist = this.allowlistForLevel(user.level);
    if (!allowlist.has(workflowKey)) {
      return {
        success: false,
        error: `Workflow "${workflowKey}" is not allowlisted for your account level`,
        data: { workflowKey },
        metadata: { durationMs: Date.now() - start },
      };
    }

    const providedIdem = String(context.parameters.idempotencyKey ?? '').trim();
    const idempotencyKey =
      providedIdem ||
      this.deriveIdempotencyKey({
        userId: context.userId,
        threadId: context.threadId,
        workflowKey,
        payload,
        runId: context.runId,
      });

    const existing = await this.dispatches.findByIdempotencyKey({
      userId: context.userId,
      idempotencyKey,
    });
    if (existing) {
      return {
        success: true,
        data: {
          dispatchId: existing.id,
          status: existing.status,
          idempotencyKey: existing.idempotencyKey,
          workflowKey: existing.workflowKey,
          reused: true,
        },
        metadata: { durationMs: Date.now() - start },
      };
    }

    const callbackUrl = String(this.config.get('N8N_CALLBACK_URL', '') || '').trim();
    if (!callbackUrl) {
      return {
        success: false,
        error: 'N8N_CALLBACK_URL is not configured',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const notifyObj =
      (context.parameters.notify as Record<string, unknown> | undefined) ?? undefined;
    const notifyChannelId = notifyObj
      ? String(notifyObj.channelId ?? '').trim() || null
      : null;
    const notifyTargetId = notifyObj
      ? String(notifyObj.targetId ?? '').trim() || null
      : null;

    const requestSnapshot: Record<string, unknown> = {
      workflowKey,
      idempotencyKey,
      // store only keys of payload for audit; keep values out unless you explicitly want them.
      payloadKeys: Object.keys(payload).slice(0, 60),
    };

    const dispatch = await this.dispatches.createPending({
      userId: context.userId,
      threadId: context.threadId,
      workflowKey,
      idempotencyKey,
      notifyChannelId,
      notifyTargetId,
      requestSnapshot,
    });

    const body: IN8nDispatchRequestBody = {
      dispatchId: dispatch.id,
      workflowKey,
      idempotencyKey,
      userContext: {
        userId: user.uid,
        identifier: user.identifier,
        level: user.level,
      },
      threadContext: {
        threadId: context.threadId,
      },
      payload,
      callback: { url: callbackUrl },
    };

    const res = await this.n8nClient.dispatch(body);
    if (!res.ok) {
      this.logger.warn(
        `Dispatch to n8n failed workflowKey=${workflowKey} dispatchId=${dispatch.id} status=${res.status}`,
      );
      await this.dispatches.markFailed({
        id: dispatch.id,
        error: res.error ?? `HTTP ${res.status}`,
      });
      return {
        success: false,
        error: res.error ?? 'Failed to dispatch workflow',
        data: { dispatchId: dispatch.id, status: res.status },
        metadata: { durationMs: Date.now() - start },
      };
    }

    await this.dispatches.markRunning({
      id: dispatch.id,
      executionId:
        typeof (res.data as any)?.executionId === 'string'
          ? ((res.data as any).executionId as string)
          : null,
    });

    return {
      success: true,
      data: {
        dispatchId: dispatch.id,
        workflowKey,
        idempotencyKey,
        status: 'RUNNING',
        dispatched: true,
      },
      metadata: { durationMs: Date.now() - start },
    };
  }
}

