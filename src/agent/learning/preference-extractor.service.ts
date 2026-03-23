import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProvidersService } from '../providers/providers.service';
import { BackgroundLlmModelService } from '../pipeline/model-router/background-llm-model.service';
import { ChatService } from '../../modules/chat/chat.service';
import {
  UserPreference,
  PreferenceCategory,
} from '../../modules/users/entities/user-preference.entity';
import {
  UserPreferenceLog,
  PreferenceEvidenceType,
} from '../../modules/users/entities/user-preference-log.entity';

const VALID_CATEGORIES: PreferenceCategory[] = [
  'communication',
  'tool_usage',
  'response_format',
  'domain_knowledge',
  'scheduling',
  'delegation',
];

const MAX_INPUT_MESSAGES = 12;
const MAX_MSG_CHARS = 600;
const MAX_OUTPUT_TOKENS = 600;

interface ExtractedPref {
  category: string;
  key: string;
  value: string;
  evidence_type: string;
  evidence: string;
}

@Injectable()
export class PreferenceExtractorService {
  private readonly logger = new Logger(PreferenceExtractorService.name);
  private readonly chain = new Map<number, Promise<void>>();

  constructor(
    private readonly chatService: ChatService,
    @InjectRepository(UserPreference)
    private readonly prefRepo: Repository<UserPreference>,
    @InjectRepository(UserPreferenceLog)
    private readonly logRepo: Repository<UserPreferenceLog>,
    @Optional() private readonly providersService?: ProvidersService,
    @Optional() private readonly backgroundLlmModel?: BackgroundLlmModelService,
  ) {}

  /**
   * Gọi không await — xếp hàng theo userId để tránh race.
   */
  scheduleExtraction(payload: {
    userId: number;
    threadId: string;
  }): void {
    if (!this.providersService) return;

    const { userId } = payload;
    const prev = this.chain.get(userId) ?? Promise.resolve();
    const job = prev
      .then(async () => {
        const model =
          (await this.backgroundLlmModel?.resolveForBackgroundJob()) ?? null;
        if (!model) return;
        await this.runExtraction(payload, model);
      })
      .catch((e) =>
        this.logger.warn(
          `[user ${userId}] Preference extraction failed: ${(e as Error).message}`,
        ),
      );
    this.chain.set(userId, job);
    void job.finally(() => {
      if (this.chain.get(userId) === job) this.chain.delete(userId);
    });
  }

  private async runExtraction(
    payload: { userId: number; threadId: string },
    model: string,
  ): Promise<void> {
    const { userId, threadId } = payload;

    const recent = await this.chatService.getRecentMessages(
      threadId,
      MAX_INPUT_MESSAGES,
    );
    if (recent.length < 3) return;

    const sorted = [...recent].reverse();
    const lines = sorted
      .map((m) => {
        const content = (m.content ?? '').slice(0, MAX_MSG_CHARS);
        return `[${m.role}] ${content}`;
      })
      .join('\n');

    const system = `Bạn là công cụ trích xuất sở thích/thói quen người dùng từ lịch sử chat.
Phân tích đoạn hội thoại và trả về JSON array chứa các preference phát hiện được.

Các category hợp lệ:
- communication: ngôn ngữ, phong cách giao tiếp, cách xưng hô
- tool_usage: công cụ/skill ưa thích hoặc muốn tránh
- response_format: kiểu trả lời (ngắn/dài, code style, ngôn ngữ lập trình)
- domain_knowledge: tech stack, dự án, lĩnh vực chuyên môn
- scheduling: múi giờ, giờ làm việc, thói quen lịch trình
- delegation: agent OpenClaw ưa thích hoặc muốn tránh

Quy tắc:
- Chỉ trích xuất những gì CÓ BẰNG CHỨNG RÕ RÀNG trong hội thoại.
- evidence_type: "explicit" (user nói thẳng), "inferred" (suy ra từ hành vi lặp lại), "corrected" (user sửa AI).
- key phải ngắn gọn, snake_case, không trùng lặp.
- Tối đa 8 preferences. Nếu không phát hiện gì → trả về [].
- CHỈ trả về JSON array, không giải thích.

Format:
[{"category":"...","key":"...","value":"...","evidence_type":"...","evidence":"..."}]`;

    const res = await this.providersService!.chat({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: lines },
      ],
      temperature: 0.15,
      maxTokens: MAX_OUTPUT_TOKENS,
    });

    const raw = (res.content ?? '').trim();
    const prefs = this.parseResponse(raw);
    if (!prefs.length) return;

    let upsertCount = 0;
    for (const p of prefs) {
      try {
        await this.upsertPreference(userId, threadId, p);
        upsertCount++;
      } catch (e) {
        this.logger.debug(
          `[user ${userId}] Skip pref ${p.category}/${p.key}: ${(e as Error).message}`,
        );
      }
    }

    if (upsertCount > 0) {
      this.logger.debug(
        `[user ${userId}] Extracted ${upsertCount} preferences from thread ${threadId.slice(0, 8)}.`,
      );
    }
  }

  private async upsertPreference(
    userId: number,
    threadId: string,
    p: ExtractedPref,
  ): Promise<void> {
    const category = p.category as PreferenceCategory;
    const key = p.key.slice(0, 255);
    const value = p.value.slice(0, 2000);
    const evidenceType = (['explicit', 'inferred', 'corrected', 'reinforced'].includes(
      p.evidence_type,
    )
      ? p.evidence_type
      : 'inferred') as PreferenceEvidenceType;

    const existing = await this.prefRepo.findOne({
      where: { userId, category, key },
    });

    const now = new Date();

    if (existing) {
      if (this.isSameValue(existing.value, value)) {
        // Reinforce: tăng confidence + evidence count
        existing.confidence = Math.min(
          0.95,
          existing.confidence + 0.1 * (1 - existing.confidence),
        );
        existing.evidenceCount += 1;
        existing.lastSeenAt = now;
        if (existing.evidenceCount >= 5 && existing.confidence >= 0.8) {
          existing.isStable = true;
        }
        await this.prefRepo.save(existing);

        await this.logRepo.save(
          this.logRepo.create({
            preferenceId: existing.id,
            userId,
            threadId,
            evidenceType: 'reinforced',
            evidenceText: (p.evidence ?? '').slice(0, 500),
          }),
        );
      } else {
        // Contradicting: giảm confidence cũ, tạo mới
        existing.confidence = Math.max(0.1, existing.confidence * 0.6);
        existing.isStable = false;
        await this.prefRepo.save(existing);

        // Xóa record cũ nếu confidence quá thấp
        if (existing.confidence < 0.2) {
          await this.prefRepo.remove(existing);
        }

        const newPref = this.prefRepo.create({
          userId,
          category,
          key,
          value,
          confidence: 0.6,
          evidenceCount: 1,
          lastSeenAt: now,
          isStable: false,
        });
        const saved = await this.prefRepo.save(newPref);

        await this.logRepo.save(
          this.logRepo.create({
            preferenceId: saved.id,
            userId,
            threadId,
            evidenceType: evidenceType === 'corrected' ? 'corrected' : evidenceType,
            evidenceText: (p.evidence ?? '').slice(0, 500),
          }),
        );
      }
    } else {
      // Tạo mới
      const newPref = this.prefRepo.create({
        userId,
        category,
        key,
        value,
        confidence: 0.5,
        evidenceCount: 1,
        lastSeenAt: now,
        isStable: false,
      });
      const saved = await this.prefRepo.save(newPref);

      await this.logRepo.save(
        this.logRepo.create({
          preferenceId: saved.id,
          userId,
          threadId,
          evidenceType,
          evidenceText: (p.evidence ?? '').slice(0, 500),
        }),
      );
    }
  }

  private isSameValue(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  private parseResponse(raw: string): ExtractedPref[] {
    try {
      // Strip markdown fences nếu LLM trả về
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];

      return parsed.filter(
        (p: any) =>
          p &&
          typeof p.category === 'string' &&
          VALID_CATEGORIES.includes(p.category as PreferenceCategory) &&
          typeof p.key === 'string' &&
          p.key.length > 0 &&
          typeof p.value === 'string' &&
          p.value.length > 0,
      );
    } catch {
      return [];
    }
  }

  /**
   * Đọc top-K preferences cho user — dùng bởi PreprocessStep.
   */
  async getTopPreferences(
    userId: number,
    limit = 20,
    minConfidence = 0.4,
  ): Promise<UserPreference[]> {
    return this.prefRepo.find({
      where: {
        userId,
      },
      order: { confidence: 'DESC', lastSeenAt: 'DESC' },
      take: limit,
    });
  }

}
