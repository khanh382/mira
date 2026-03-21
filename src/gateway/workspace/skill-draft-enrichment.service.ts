import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ProvidersService } from '../../agent/providers/providers.service';
import { ModelRouterService } from '../../agent/pipeline/model-router/model-router.service';
import {
  IntentType,
  ModelTier,
} from '../../agent/pipeline/model-router/model-tier.enum';
import { WorkspaceService } from './workspace.service';

export type SkillDraftStepAnnotation = {
  index: number;
  label: string;
  intent: string;
};

export type SkillDraftLlmResult = {
  /** Model đã gọi (ghi vào draft). */
  modelUsed?: string;
  /** Chuỗi gốc từ user (echo hoặc tóm tắt). */
  userRequest?: string;
  /** Các bước B1…Bn theo đúng ý người dùng (markdown). */
  userRequestedSteps: string;
  /** Tiêu chí thành công + lưu ý vận hành. */
  executionNotes: string;
  /** Gắn nhãn từng bước kỹ thuật (index 0-based). */
  stepAnnotations: SkillDraftStepAnnotation[];
};

/**
 * Gọi LLM để ánh xạ yêu cầu tự nhiên + log bước browser → B1…Bn, intent, executionNotes.
 * Không chặn luồng chính nếu LLM lỗi (caller trả null).
 */
@Injectable()
export class SkillDraftEnrichmentService {
  private readonly logger = new Logger(SkillDraftEnrichmentService.name);

  constructor(
    private readonly providersService: ProvidersService,
    private readonly modelRouter: ModelRouterService,
    private readonly workspaceService: WorkspaceService,
  ) {}

  private extractJsonObject(text: string): Record<string, unknown> | null {
    const t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const payload = fence ? fence[1] : t;
    try {
      return JSON.parse(payload.trim()) as Record<string, unknown>;
    } catch {
      const start = payload.indexOf('{');
      const end = payload.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(payload.slice(start, end + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  private simplifyStepsForPrompt(steps: unknown[]): unknown[] {
    return steps.map((s, i) => {
      if (!s || typeof s !== 'object') return { index: i, raw: s };
      const o = s as Record<string, unknown>;
      const action = String(o.action ?? '');
      const out: Record<string, unknown> = { index: i, action };
      if (typeof o.url === 'string') out.url = o.url;
      if (typeof o.selector === 'string') {
        out.selector =
          o.selector.length > 400 ? `${o.selector.slice(0, 400)}…` : o.selector;
      }
      if (typeof o.text === 'string') {
        out.text =
          o.text.length > 200 ? `${o.text.slice(0, 200)}…` : o.text;
      }
      if (typeof o.script === 'string') {
        out.script =
          o.script.length > 300 ? `${o.script.slice(0, 300)}…` : o.script;
      }
      if (o.optional === true) out.optional = true;
      return out;
    });
  }

  private simplifyRunLogs(logs: unknown[]): unknown[] {
    return logs.slice(0, 40).map((r, i) => {
      if (!r || typeof r !== 'object') return { index: i, raw: r };
      const o = r as Record<string, unknown>;
      return {
        index: i,
        action: o.action,
        success: o.success,
        error:
          typeof o.error === 'string' && o.error.length > 300
            ? `${o.error.slice(0, 300)}…`
            : o.error,
        currentUrl: o.currentUrl,
        usedSelector: o.usedSelector,
      };
    });
  }

  /**
   * Gọi LLM một lần; trả null nếu không cấu hình provider hoặc parse lỗi.
   */
  async enrichFromRequestAndLogs(opts: {
    userId: number;
    userRequest?: string;
    steps: unknown[];
    runStepLogs?: unknown[];
    failureError?: string;
  }): Promise<SkillDraftLlmResult | null> {
    try {
      const decision = await this.modelRouter.resolveModel(
        opts.userId,
        IntentType.TOOL_CALL,
        { skillTier: ModelTier.CHEAP },
      );
      const model = decision.model;

      const userReq =
        typeof opts.userRequest === 'string' && opts.userRequest.trim()
          ? opts.userRequest.trim()
          : '(Không có văn bản yêu cầu kèm — chỉ dựa vào các bước kỹ thuật bên dưới.)';

      const system = `Bạn là trợ lý kỹ thuật tự động hóa trình duyệt (Playwright).
Nhiệm vụ: đối chiếu YÊU CẦU NGƯỜI DÙNG (nếu có) với DANH SÁCH BƯỚC ĐÃ CHẠY / MẪU BƯỚC,
rồi trả về JSON duy nhất (không markdown ngoài JSON) với:
- userRequestedSteps: mô tả các bước B1, B2, … bằng tiếng Việt, khớp ý người dùng khi có thể.
- executionNotes: tiêu chí thành công, thứ tự, delay 1–3s nếu user nhắc, điều cần tránh.
- stepAnnotations: mảng { "index": number (0-based), "label": "B1 — …", "intent": "một dòng tiếng Việt" } cho TỪNG bước trong mảng steps (cùng số phần tử).
Nếu không có user request, vẫn sinh B1…Bn dựa trên thứ tự action (navigate, click, type, …).`;

      const payload = {
        userRequest: userReq,
        steps: this.simplifyStepsForPrompt(Array.isArray(opts.steps) ? opts.steps : []),
        runStepLogs: this.simplifyRunLogs(
          Array.isArray(opts.runStepLogs) ? opts.runStepLogs : [],
        ),
        failureError: opts.failureError ?? '',
      };

      const userMsg = `Dữ liệu:\n${JSON.stringify(payload, null, 2)}`;

      const res = await this.providersService.chat({
        model,
        temperature: 0.2,
        maxTokens: 4096,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMsg },
        ],
      });

      const parsed = this.extractJsonObject(res.content || '');
      if (!parsed) {
        this.logger.warn('skill_draft LLM: could not parse JSON from response');
        return null;
      }

      const userRequestedSteps = String(parsed.userRequestedSteps ?? '').trim();
      const executionNotes = String(parsed.executionNotes ?? '').trim();
      const rawAnn = parsed.stepAnnotations;
      const stepAnnotations: SkillDraftStepAnnotation[] = [];
      if (Array.isArray(rawAnn)) {
        for (const a of rawAnn) {
          if (!a || typeof a !== 'object') continue;
          const o = a as Record<string, unknown>;
          const index = Number(o.index);
          if (!Number.isFinite(index) || index < 0) continue;
          stepAnnotations.push({
            index: Math.floor(index),
            label: String(o.label ?? '').trim() || `B${index + 1}`,
            intent: String(o.intent ?? '').trim(),
          });
        }
      }

      if (!userRequestedSteps && !executionNotes && stepAnnotations.length === 0) {
        return null;
      }

      return {
        modelUsed: model,
        userRequest:
          typeof opts.userRequest === 'string' && opts.userRequest.trim()
            ? opts.userRequest.trim()
            : undefined,
        userRequestedSteps:
          userRequestedSteps ||
          '*(LLM không trả userRequestedSteps — xem các bước trong `steps`.)*',
        executionNotes:
          executionNotes ||
          '*(LLM không trả executionNotes — bổ sung thủ công nếu cần.)*',
        stepAnnotations,
      };
    } catch (e) {
      this.logger.warn(
        `skill_draft enrichment failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /**
   * Đọc skill_draft.json trên đĩa, gọi LLM, ghi đè thêm field AI + gắn stepLabel/intent vào từng step.
   */
  async applyEnrichmentToDraftFile(
    userId: number,
    identifier: string,
    draftGroupId: string,
    opts?: { userRequest?: string; force?: boolean },
  ): Promise<SkillDraftLlmResult | null> {
    if (!identifier?.trim() || !draftGroupId?.trim()) return null;
    const draftPath = path.join(
      this.workspaceService.getUserDir(identifier.trim()),
      'browser_debug',
      draftGroupId.trim(),
      'skill_draft.json',
    );
    let raw: string;
    try {
      raw = await fs.readFile(draftPath, 'utf8');
    } catch {
      return null;
    }
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (!opts?.force && typeof doc.aiEnrichedAt === 'string' && doc.aiEnrichedAt) {
      return null;
    }
    const steps = Array.isArray(doc.steps) ? doc.steps : [];
    const runStepLogs = Array.isArray(doc.runStepLogs) ? doc.runStepLogs : [];
    const failureError =
      typeof doc.failureError === 'string' ? doc.failureError : undefined;
    const mergedUserRequest =
      (typeof opts?.userRequest === 'string' && opts.userRequest.trim()
        ? opts.userRequest.trim()
        : null) ??
      (typeof doc.userRequest === 'string' && doc.userRequest.trim()
        ? doc.userRequest.trim()
        : undefined);

    const enriched = await this.enrichFromRequestAndLogs({
      userId,
      userRequest: mergedUserRequest,
      steps,
      runStepLogs,
      failureError,
    });
    if (!enriched) return null;

    const nextSteps = steps.map((s, i) => {
      if (!s || typeof s !== 'object') return s;
      const ann = enriched.stepAnnotations.find((a) => a.index === i);
      if (!ann) return s;
      return {
        ...(s as Record<string, unknown>),
        stepLabel: ann.label,
        intent: ann.intent,
      };
    });

    const out = {
      ...doc,
      steps: nextSteps,
      userRequest: mergedUserRequest ?? doc.userRequest,
      userRequestedSteps: enriched.userRequestedSteps,
      executionNotes: enriched.executionNotes,
      aiEnrichedAt: new Date().toISOString(),
      aiEnrichmentModel: enriched.modelUsed ?? 'unknown',
    };
    await fs.writeFile(draftPath, JSON.stringify(out, null, 2), 'utf8');
    return enriched;
  }
}
