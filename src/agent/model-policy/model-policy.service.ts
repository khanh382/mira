import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ModelPolicy, ModelPolicyScope } from './entities/model-policy.entity';
import { AgentRunOutcome } from '../feedback/entities/agent-run.entity';
import { MODEL_PRIORITY, ModelTier } from '../pipeline/model-router/model-tier.enum';

@Injectable()
export class ModelPolicyService {
  constructor(
    @InjectRepository(ModelPolicy)
    private readonly repo: Repository<ModelPolicy>,
  ) {}

  buildSignature(params: { intent: string; primarySkillHint?: string | null }): string {
    const intent = String(params.intent ?? '').trim().toLowerCase() || 'unknown';
    const skill = String(params.primarySkillHint ?? '').trim();
    return skill ? `${intent}|${skill}` : `${intent}|`;
  }

  async resolvePolicy(params: {
    intent: string;
    primarySkillHint?: string | null;
  }): Promise<ModelPolicy | null> {
    const signature = this.buildSignature(params);

    // Prefer specific (intent|skill) over generic (intent|).
    const specific = await this.repo.findOne({
      where: { scope: ModelPolicyScope.GLOBAL, signature },
    });
    if (specific) return specific;

    const generic = await this.repo.findOne({
      where: {
        scope: ModelPolicyScope.GLOBAL,
        signature: this.buildSignature({ intent: params.intent, primarySkillHint: null }),
      },
    });
    return generic ?? null;
  }

  private nextTierUp(tier: string | null): string | null {
    const t = String(tier ?? '').toLowerCase();
    if (!t) return null;
    if (t === 'cheap') return 'skill';
    if (t === 'skill') return 'expert';
    return null;
  }

  async applyPolicyToTierAndModel(params: {
    intent: string;
    primarySkillHint?: string | null;
    currentTier: ModelTier;
    currentModel?: string | null;
  }): Promise<{ tier: ModelTier; forceModel?: string; reason?: string } | null> {
    const policy = await this.resolvePolicy({
      intent: params.intent,
      primarySkillHint: params.primarySkillHint ?? null,
    });
    if (!policy) return null;

    const preferredTier = policy.preferredTier?.toLowerCase().trim() ?? null;
    const preferredModel = policy.preferredModel?.trim() ?? null;

    const tier =
      preferredTier && Object.values(ModelTier).includes(preferredTier.toUpperCase() as any)
        ? (preferredTier.toUpperCase() as ModelTier)
        : params.currentTier;

    const reason = `policy:${policy.signature} ok=${policy.okCount} bad=${policy.badCount}`;

    if (preferredModel) {
      return { tier, forceModel: preferredModel, reason };
    }

    if (tier !== params.currentTier) {
      return { tier, reason };
    }

    return null;
  }

  async updateFromOwnerFeedback(params: {
    ownerUid: number;
    intent: string;
    primarySkill: string | null;
    outcome: AgentRunOutcome;
    model: string | null;
    tier: string | null;
  }): Promise<void> {
    const intent = String(params.intent ?? '').trim().toLowerCase() || 'unknown';
    const primarySkill = params.primarySkill?.trim() || null;
    const signature = this.buildSignature({ intent, primarySkillHint: primarySkill });

    let row =
      (await this.repo.findOne({
        where: { scope: ModelPolicyScope.GLOBAL, signature },
      })) ?? null;

    if (!row) {
      row = this.repo.create({
        scope: ModelPolicyScope.GLOBAL,
        signature,
        intent,
        primarySkill,
        preferredTier: null,
        preferredModel: null,
        okCount: 0,
        badCount: 0,
        lastFeedbackByUid: null,
        lastFeedbackAt: null,
      });
    }

    row.lastFeedbackByUid = params.ownerUid;
    row.lastFeedbackAt = new Date();

    if (params.outcome === AgentRunOutcome.OK) {
      row.okCount += 1;
      // When owner says OK, we lock-in this (tier, model) as preferred for everyone.
      if (params.tier) row.preferredTier = String(params.tier).toLowerCase();
      if (params.model) row.preferredModel = String(params.model);
    } else if (params.outcome === AgentRunOutcome.BAD) {
      row.badCount += 1;

      // Escalation rule: after 2 BAD, escalate tier one step (cheap->skill, skill->expert),
      // and clear preferredModel so router can pick a better one within that tier.
      if (row.badCount >= 2) {
        const baseTier = row.preferredTier ?? (params.tier ? String(params.tier).toLowerCase() : null);
        const next = this.nextTierUp(baseTier);
        if (next) {
          row.preferredTier = next;
          row.preferredModel = null;
        }
      }
    }

    await this.repo.save(row);
  }

  /**
   * Choose a retry model (used by /retry) — switch within tier first, then escalate.
   */
  chooseRetryModel(params: {
    currentTier: string | null;
    currentModel: string | null;
  }): { tier: ModelTier; model: string } | null {
    const tierStr = String(params.currentTier ?? '').toUpperCase();
    const tier = (Object.values(ModelTier) as string[]).includes(tierStr)
      ? (tierStr as ModelTier)
      : null;
    if (!tier) return null;

    const candidates = MODEL_PRIORITY[tier] ?? [];
    const current = String(params.currentModel ?? '').trim();
    const idx = current
      ? candidates.findIndex((c) => c.id === current || c.openrouterModel === current)
      : -1;

    const nextInTier = candidates[idx + 1];
    if (nextInTier?.id) {
      return { tier, model: nextInTier.id };
    }

    // Escalate tier if possible.
    const nextTier =
      tier === ModelTier.CHEAP ? ModelTier.SKILL : tier === ModelTier.SKILL ? ModelTier.EXPERT : null;
    if (!nextTier) return null;
    const nextCandidates = MODEL_PRIORITY[nextTier] ?? [];
    const pick = nextCandidates[0];
    if (!pick?.id) return null;
    return { tier: nextTier, model: pick.id };
  }
}

