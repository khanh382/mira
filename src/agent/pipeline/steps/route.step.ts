import { Injectable, Logger } from '@nestjs/common';
import { HooksService } from '../../hooks/hooks.service';
import { PluginHookName } from '../../hooks/enums/hook-events.enum';
import { SkillsService } from '../../skills/skills.service';
import { ModelRouterService } from '../model-router/model-router.service';
import {
  IPipelineContext,
  PipelineStage,
} from '../interfaces/pipeline-context.interface';
import { IntentType, ModelTier } from '../model-router/model-tier.enum';
import { TaskMemoryService } from '../../../gateway/workspace/task-memory.service';

@Injectable()
export class RouteStep {
  private readonly logger = new Logger(RouteStep.name);

  constructor(
    private readonly hooksService: HooksService,
    private readonly modelRouter: ModelRouterService,
    private readonly skillsService: SkillsService,
    private readonly taskMemoryService: TaskMemoryService,
  ) {}

  async execute(context: IPipelineContext): Promise<IPipelineContext> {
    this.logger.debug(`[${context.runId}] Routing message`);

    // ─── Step 1: Phân loại intent (heuristic, không gọi LLM) ─────
    let intent = this.modelRouter.classifyIntentHeuristic(
      context.processedContent,
    );

    // Weather continuation guard:
    // If current message is a short follow-up like "dùng browser đi" but the last
    // user turn in this thread was about weather, force TOOL_CALL so we don't
    // answer "xin lỗi/không làm được" due to SMALLTALK classification.
    if (intent === IntentType.SMALLTALK) {
      const current = (context.processedContent ?? '').toLowerCase();
      const lastUser = [...(context.conversationHistory ?? [])]
        .slice()
        .reverse()
        .find((m) => m.role === 'user')?.content?.toLowerCase();

      const currentWantsBrowserOrSearch =
        /(?:dùng|dung)\s*browser|trình\s*duyệt|trinh\s*duyet|search|tìm\s*kiếm|tim\s*kiem|mo\s*web|mở\s*web|\bthử\s*lại\b|try\s*again|làm\s*lại|lanh\s*lai|tiếp\s*tục|tiep\s*tuc/i.test(
          current,
        );

      const lastWasWeatherRequest =
        /(\bthời\s*tiết\b|\bthoi\s*tiet\b|\bdự\s*báo\b|\bdu\s*bao\b|\bweather\b|\bforecast\b)/i.test(
          lastUser ?? '',
        );

      if (currentWantsBrowserOrSearch && lastWasWeatherRequest) {
        intent = IntentType.TOOL_CALL;
      }
    }

    // ─── Step 2: Xác định minModelTier từ active skills (nếu có) ──
    const skillTier = this.resolveSkillTier(context.activeSkills);

    // ─── Step 3: Chọn model qua ModelRouter ───────────────────────
    const decision = await this.modelRouter.resolveModel(
      context.userId,
      intent,
      { skillTier },
    );

    context.model = decision.model;
    context.routing = {
      intent,
      tier: decision.tier,
      model: decision.model,
      reason: decision.reason,
      fallback: decision.fallback,
    };

    this.logger.log(
      `[${context.runId}] Route → intent=${intent}, tier=${decision.tier}, ` +
        `model=${decision.model}${decision.fallback ? ' (fallback)' : ''} ` +
        `[${decision.reason}]`,
    );

    // ─── Step 4: Hook cho plugin override ─────────────────────────
    const hookResult = await this.hooksService.executePluginHook(
      PluginHookName.BEFORE_MODEL_RESOLVE,
      {
        model: context.model,
        intent,
        tier: decision.tier,
        userId: context.userId,
        threadId: context.threadId,
      },
    );

    if (hookResult.model && hookResult.model !== context.model) {
      this.logger.log(
        `[${context.runId}] Hook override model: ${context.model} → ${hookResult.model}`,
      );
      context.model = hookResult.model;
    }

    await this.taskMemoryService.attachForTurn(context, intent);

    context.targetChannelId =
      context.targetChannelId ?? context.sourceChannelId;
    context.targetId = context.targetId ?? context.inboundMessage.senderId;

    context.stage = PipelineStage.ROUTED;
    return context;
  }

  /**
   * Tìm minModelTier cao nhất trong danh sách active skills.
   * Ví dụ: nếu 1 skill yêu cầu SKILL tier → toàn bộ pipeline phải dùng >= SKILL.
   */
  private resolveSkillTier(activeSkills?: string[]): ModelTier | undefined {
    if (!activeSkills?.length) return undefined;

    const tierRank: Record<ModelTier, number> = {
      [ModelTier.CHEAP]: 0,
      [ModelTier.PROCESSOR]: 1,
      [ModelTier.SKILL]: 2,
      [ModelTier.EXPERT]: 3,
    };

    let maxTier: ModelTier | undefined;
    let maxRank = -1;

    for (const code of activeSkills) {
      const runner = this.skillsService.getRunner(code);
      const tier = runner?.definition?.minModelTier;
      if (tier && tierRank[tier] > maxRank) {
        maxTier = tier;
        maxRank = tierRank[tier];
      }
    }

    return maxTier;
  }
}
