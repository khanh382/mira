import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentRun, AgentRunOutcome } from './entities/agent-run.entity';
import { IPipelineContext } from '../pipeline/interfaces/pipeline-context.interface';
import { UsersService } from '../../modules/users/users.service';
import { UserLevel } from '../../modules/users/entities/user.entity';
import { ModelPolicyService } from '../model-policy/model-policy.service';

@Injectable()
export class AgentFeedbackService {
  constructor(
    @InjectRepository(AgentRun)
    private readonly runsRepo: Repository<AgentRun>,
    private readonly usersService: UsersService,
    private readonly policy: ModelPolicyService,
  ) {}

  async getLatestRunForThread(params: {
    userId: number;
    threadId: string;
  }): Promise<AgentRun | null> {
    return (
      (await this.runsRepo
        .createQueryBuilder('r')
        .where('r.uid = :userId', { userId: params.userId })
        .andWhere('r.thread_id = :threadId', { threadId: params.threadId })
        .orderBy('r.created_at', 'DESC')
        .getOne()
        .catch(() => null)) ?? null
    );
  }

  async recordPipelineRun(context: IPipelineContext): Promise<void> {
    const toolCalls = (context.agentToolCalls ?? []).map((c: any) => {
      const r = c?.result as Record<string, unknown> | undefined;
      const ok =
        r && typeof r === 'object' && 'success' in r
          ? (r.success as boolean)
          : undefined;
      return {
        skillCode: String(c?.skillCode ?? ''),
        success: typeof ok === 'boolean' ? ok : undefined,
      };
    });

    const row = this.runsRepo.create({
      runId: context.runId,
      userId: context.userId,
      threadId: context.threadId,
      sourceChannelId: context.sourceChannelId ?? 'unknown',
      intent: context.routing?.intent ? String(context.routing.intent) : null,
      tier: context.routing?.tier ? String(context.routing.tier) : null,
      model: context.routing?.model
        ? String(context.routing.model)
        : context.model
          ? String(context.model)
          : null,
      tokensUsed: Number(context.tokensUsed ?? 0) || 0,
      requestPreview: String(context.processedContent ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 800) || null,
      stage: context.stage ? String(context.stage) : null,
      error: context.error
        ? context.error instanceof Error
          ? context.error.message
          : String(context.error)
        : null,
      toolCalls: toolCalls.length ? toolCalls : null,
      // userOutcome defaults to UNKNOWN
    });

    // Upsert semantics: if a run was already recorded (rare), update the row.
    await this.runsRepo.save(row);
  }

  async markLastRunOutcome(params: {
    userId: number;
    threadId: string;
    outcome: AgentRunOutcome;
    feedbackText?: string | null;
  }): Promise<
    | { ok: true; runId: string; prevOutcome: AgentRunOutcome; newOutcome: AgentRunOutcome }
    | { ok: false; error: string }
  > {
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000);

    const candidate =
      (await this.runsRepo
        .createQueryBuilder('r')
        .where('r.uid = :userId', { userId: params.userId })
        .andWhere('r.thread_id = :threadId', { threadId: params.threadId })
        .andWhere('r.created_at >= :since', { since })
        .andWhere('r.user_outcome = :unknown', { unknown: AgentRunOutcome.UNKNOWN })
        .orderBy('r.created_at', 'DESC')
        .getOne()) ||
      (await this.runsRepo
        .createQueryBuilder('r')
        .where('r.uid = :userId', { userId: params.userId })
        .andWhere('r.thread_id = :threadId', { threadId: params.threadId })
        .andWhere('r.created_at >= :since', { since })
        .orderBy('r.created_at', 'DESC')
        .getOne());

    if (!candidate) {
      return { ok: false, error: 'Không tìm thấy lượt chạy gần đây trong thread này để gắn feedback.' };
    }

    const prevOutcome = candidate.userOutcome;
    candidate.userOutcome = params.outcome;
    candidate.userFeedbackText = (params.feedbackText ?? '').trim() || null;
    candidate.userFeedbackAt = new Date();
    await this.runsRepo.save(candidate);

    // Learning source: ONLY owner feedback updates global model policies.
    try {
      const u = await this.usersService.findById(params.userId);
      if (u?.level === UserLevel.OWNER) {
        const primarySkill =
          Array.isArray(candidate.toolCalls) && candidate.toolCalls.length
            ? String((candidate.toolCalls[0] as any)?.skillCode ?? '').trim() || null
            : null;
        await this.policy.updateFromOwnerFeedback({
          ownerUid: params.userId,
          intent: candidate.intent ?? 'unknown',
          primarySkill,
          outcome: params.outcome,
          model: candidate.model,
          tier: candidate.tier,
        });
      }
    } catch {
      /* best-effort */
    }

    return {
      ok: true,
      runId: candidate.runId,
      prevOutcome,
      newOutcome: candidate.userOutcome,
    };
  }

  /**
   * Simple adaptive routing: only escalate tier when recent runs are bad.
   * We intentionally avoid automatic downgrades to protect quality.
   */
  async shouldEscalateForIntent(params: {
    userId: number;
    intent: string;
    currentTier: string;
  }): Promise<{ escalateToTier: string | null; reason: string | null }> {
    const intent = params.intent;
    const currentTier = params.currentTier;

    if (!intent || !currentTier) return { escalateToTier: null, reason: null };
    if (intent !== 'tool_call') return { escalateToTier: null, reason: null };
    if (currentTier !== 'cheap') return { escalateToTier: null, reason: null };

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recent = await this.runsRepo
      .createQueryBuilder('r')
      .select(['r.run_id', 'r.user_outcome', 'r.stage', 'r.error', 'r.created_at'])
      .where('r.uid = :userId', { userId: params.userId })
      .andWhere('r.intent = :intent', { intent })
      .andWhere('r.created_at >= :since', { since })
      .orderBy('r.created_at', 'DESC')
      .limit(12)
      .getMany();

    if (recent.length < 5) return { escalateToTier: null, reason: null };

    const badCount = recent.filter((r) => r.userOutcome === AgentRunOutcome.BAD).length;
    const failCount = recent.filter((r) => (r.stage ?? '').toLowerCase().includes('failed') || !!r.error)
      .length;

    // Escalate if user explicitly said "bad" multiple times, or pipeline failed repeatedly.
    if (badCount >= 2 || failCount >= 3) {
      return {
        escalateToTier: 'skill',
        reason: `adaptive-escalation (tool_call): bad=${badCount}, failed=${failCount} in last ${recent.length}`,
      };
    }

    return { escalateToTier: null, reason: null };
  }

  async getToolReliabilityHintBlock(params: {
    userId: number;
    limit?: number;
  }): Promise<string | null> {
    const limit = Math.max(1, Math.min(8, params.limit ?? 5));
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const rows = await this.runsRepo
      .createQueryBuilder('r')
      .select(['r.tool_calls'])
      .where('r.uid = :userId', { userId: params.userId })
      .andWhere('r.created_at >= :since', { since })
      .andWhere('r.tool_calls IS NOT NULL')
      .orderBy('r.created_at', 'DESC')
      .limit(60)
      .getMany();

    const counts = new Map<string, { ok: number; bad: number }>();
    for (const r of rows) {
      const tc = (r.toolCalls ?? []) as Array<{ skillCode: string; success?: boolean }>;
      for (const c of tc) {
        const code = String(c.skillCode ?? '').trim();
        if (!code) continue;
        const cur = counts.get(code) ?? { ok: 0, bad: 0 };
        if (c.success === true) cur.ok += 1;
        else if (c.success === false) cur.bad += 1;
        counts.set(code, cur);
      }
    }

    const ranked = [...counts.entries()]
      .map(([skillCode, v]) => ({
        skillCode,
        ok: v.ok,
        bad: v.bad,
        total: v.ok + v.bad,
      }))
      .filter((x) => x.total >= 3 && x.bad >= 2)
      .sort((a, b) => b.bad - a.bad)
      .slice(0, limit);

    if (!ranked.length) return null;

    const lines = ranked.map((x) => `- ${x.skillCode}: fail=${x.bad}/${x.total}`);
    return (
      `## Thống kê tool gần đây (tự học từ kết quả tool; ưu tiên giảm chi phí thử-sai)\n` +
      `Một số tool hay lỗi với user này trong ~14 ngày qua:\n` +
      lines.join('\n') +
      `\nNguyên tắc: nếu yêu cầu có nhiều cách, ưu tiên cách ít gọi tool/lặp lại với các tool hay fail; nếu buộc dùng tool đó, hãy kiểm tra tham số/tiền điều kiện kỹ hơn.`
    );
  }
}

