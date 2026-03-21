import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GlobalConfigService } from '../../../modules/global-config/global-config.service';
import { UsersService } from '../../../modules/users/users.service';
import { UserLevel } from '../../../modules/users/entities/user.entity';
import {
  ModelTier,
  IntentType,
  ModelCandidate,
  MODEL_PRIORITY,
} from './model-tier.enum';
import { getSharedSkillsPathMentionRegex } from '../../../config/brain-dir.config';

interface RoutingDecision {
  model: string;
  tier: ModelTier;
  reason: string;
  fallback: boolean;
}

/**
 * ModelRouterService — Smart Routing Logic.
 *
 * 4-step routing:
 *   Bước 1 (Triage):    CHEAP  → DeepSeek-V3 / Gemini Flash
 *   Bước 2 (Tool Call):  SKILL  → DeepSeek-V3
 *   Bước 3 (Big Data):   PROCESSOR → Gemini 1.5 Flash (1M+ context)
 *   Bước 4 (Reasoning):  EXPERT → DeepSeek-R1 / GPT-4o
 *
 * User-level cost control:
 *   Owner:             Mặc định SKILL tier cho mọi thứ
 *   Colleague/Client:  Mặc định CHEAP, chỉ escalate khi cần
 *
 * Fallback chain:
 *   Mỗi tier có danh sách models xếp ưu tiên.
 *   Nếu provider không có API key → skip sang model tiếp theo.
 *   OpenRouter là universal fallback — nếu có key, mọi model đều khả dụng.
 */
@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger(ModelRouterService.name);
  private availableProviders: Set<string> = new Set();
  private hasOpenRouter = false;
  private initialized = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly globalConfigService: GlobalConfigService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Load available providers từ DB config (lazy, cached).
   */
  private async ensureInit(): Promise<void> {
    if (this.initialized) return;

    const config = await this.globalConfigService.getConfig();
    if (!config) {
      this.initialized = true;
      return;
    }

    const providerKeyMap: Record<string, string | null> = {
      openai: config.openaiApiKey,
      anthropic: config.anthropicApiKey,
      gemini: config.geminiApiKey,
      deepseek: config.deepseekApiKey,
      openrouter: config.openrouterApiKey,
    };

    for (const [provider, key] of Object.entries(providerKeyMap)) {
      if (key?.trim()) {
        this.availableProviders.add(provider);
      }
    }

    this.hasOpenRouter = this.availableProviders.has('openrouter');
    this.initialized = true;

    this.logger.log(
      `Model router ready: providers=[${[...this.availableProviders].join(',')}], ` +
        `openrouter=${this.hasOpenRouter}`,
    );
  }

  /**
   * Invalidate cache khi config thay đổi (gọi sau khi update API keys).
   */
  invalidateCache(): void {
    this.initialized = false;
    this.availableProviders.clear();
  }

  // ─── Core Routing ─────────────────────────────────────────────────

  /**
   * Chọn model cho bước Triage (phân loại intent).
   * Luôn dùng CHEAP tier.
   */
  async resolveTriageModel(): Promise<RoutingDecision> {
    await this.ensureInit();
    return this.pickModel(ModelTier.CHEAP, 'triage/intent classification');
  }

  /**
   * Chọn model dựa trên intent đã phân loại + user level.
   */
  async resolveModel(
    userId: number,
    intent: IntentType,
    options?: {
      skillTier?: ModelTier;
      forceModel?: string;
      dataSize?: number;
    },
  ): Promise<RoutingDecision> {
    await this.ensureInit();

    if (options?.forceModel) {
      return {
        model: options.forceModel,
        tier: ModelTier.SKILL,
        reason: 'force override',
        fallback: false,
      };
    }

    const user = await this.usersService.findById(userId);
    const userLevel = user?.level ?? UserLevel.CLIENT;

    const tier = this.determineTier(intent, userLevel, options);

    if (userLevel !== UserLevel.OWNER && this.isHighTier(tier)) {
      this.logger.debug(
        `User ${userId} (${userLevel}) requesting ${tier} tier — checking access`,
      );
      // Colleague/Client: block EXPERT tier trừ khi có premium (TODO: check premium)
      // Hiện tại: cho phép SKILL, block EXPERT → downgrade về SKILL
      if (tier === ModelTier.EXPERT && userLevel === UserLevel.CLIENT) {
        return this.pickModel(
          ModelTier.SKILL,
          `downgraded from expert (client user ${userId})`,
        );
      }
    }

    return this.pickModel(tier, `intent=${intent}, user=${userLevel}`);
  }

  /**
   * Chọn model cho xử lý dữ liệu lớn (sau khi tool trả về nhiều data).
   */
  async resolveProcessorModel(dataSize: number): Promise<RoutingDecision> {
    await this.ensureInit();

    if (dataSize > 100000) {
      return this.pickModel(ModelTier.PROCESSOR, `big data: ${dataSize} chars`);
    }
    return this.pickModel(ModelTier.CHEAP, `small data: ${dataSize} chars`);
  }

  /**
   * Chọn model cho escalation (khi kết quả mâu thuẫn hoặc cần reasoning).
   */
  async resolveEscalationModel(userId: number): Promise<RoutingDecision> {
    await this.ensureInit();

    const user = await this.usersService.findById(userId);
    if (user?.level === UserLevel.CLIENT) {
      return this.pickModel(
        ModelTier.SKILL,
        'escalation (client → capped at skill)',
      );
    }

    return this.pickModel(ModelTier.EXPERT, 'escalation/reasoning');
  }

  // ─── Tier Determination ───────────────────────────────────────────

  private determineTier(
    intent: IntentType,
    userLevel: UserLevel,
    options?: { skillTier?: ModelTier; dataSize?: number },
  ): ModelTier {
    // Owner: mặc định SKILL cho mọi thứ, EXPERT khi cần reasoning
    if (userLevel === UserLevel.OWNER) {
      switch (intent) {
        case IntentType.SMALLTALK:
          return ModelTier.CHEAP;
        case IntentType.REASONING:
          return ModelTier.EXPERT;
        case IntentType.BIG_DATA:
          return ModelTier.PROCESSOR;
        default:
          return ModelTier.SKILL;
      }
    }

    // Colleague/Client: routing tiết kiệm
    switch (intent) {
      case IntentType.SMALLTALK:
        return ModelTier.CHEAP;

      case IntentType.TOOL_CALL:
        return options?.skillTier ?? ModelTier.SKILL;

      case IntentType.BIG_DATA:
        return ModelTier.PROCESSOR;

      case IntentType.REASONING:
        return userLevel === UserLevel.COLLEAGUE
          ? ModelTier.EXPERT
          : ModelTier.SKILL;

      default:
        return ModelTier.CHEAP;
    }
  }

  private isHighTier(tier: ModelTier): boolean {
    return tier === ModelTier.EXPERT;
  }

  // ─── Model Selection with Fallback ────────────────────────────────

  private pickModel(tier: ModelTier, reason: string): RoutingDecision {
    const candidates = MODEL_PRIORITY[tier];

    // Thử từng model theo thứ tự ưu tiên
    for (const candidate of candidates) {
      if (this.isModelAvailable(candidate)) {
        return {
          model: candidate.id,
          tier,
          reason,
          fallback: false,
        };
      }
    }

    // Fallback qua OpenRouter nếu có
    if (this.hasOpenRouter) {
      const preferred = candidates[0];
      const orModel = preferred.openrouterModel ?? preferred.id;
      return {
        model: `openrouter/${orModel}`,
        tier,
        reason: `${reason} (via openrouter fallback)`,
        fallback: true,
      };
    }

    // Fallback cuối: tìm BẤT KỲ model nào available, ưu tiên cheap
    const allTiers = [
      ModelTier.CHEAP,
      ModelTier.SKILL,
      ModelTier.PROCESSOR,
      ModelTier.EXPERT,
    ];
    for (const fallbackTier of allTiers) {
      for (const candidate of MODEL_PRIORITY[fallbackTier]) {
        if (this.isModelAvailable(candidate)) {
          return {
            model: candidate.id,
            tier: fallbackTier,
            reason: `${reason} (emergency fallback from ${tier} to ${fallbackTier})`,
            fallback: true,
          };
        }
      }
    }

    // Không có model nào → dùng DEFAULT_MODEL từ .env
    const defaultModel = this.configService.get(
      'DEFAULT_MODEL',
      'openai/gpt-4o',
    );
    return {
      model: defaultModel,
      tier,
      reason: `${reason} (no providers available, using DEFAULT_MODEL)`,
      fallback: true,
    };
  }

  private isModelAvailable(candidate: ModelCandidate): boolean {
    return this.availableProviders.has(candidate.provider);
  }

  // ─── Intent Classification (dùng ở Triage step) ──────────────────

  /**
   * Phân loại intent từ nội dung message.
   *
   * Bước 1 trong pipeline: gọi CHEAP model để classify.
   * Trả về IntentType để bước sau chọn model phù hợp.
   *
   * Heuristic nhanh (trước khi gọi LLM):
   * - Tin nhắn ngắn + không keyword tool → SMALLTALK
   * - Có keyword tool/action → TOOL_CALL
   * - Yêu cầu phân tích/lập kế hoạch phức tạp → REASONING
   */
  classifyIntentHeuristic(content: string): IntentType {
    const lower = content.toLowerCase().trim();
    const wordCount = lower.split(/\s+/).length;

    // Shared skills folder / skills_registry_manage — must use tools (not smalltalk).
    const t = lower.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    const skillsRegistryIntent =
      /\b(skills_registry|skill registry|skills registry)\b/.test(lower) ||
      getSharedSkillsPathMentionRegex().test(lower) ||
      /(trong\s+(db|database|sql)|\bdb\b|database|skills_registry)/i.test(
        lower,
      ) ||
      /(liệt kê|liet ke|danh sách|danh sach).{0,40}\bskill/i.test(lower) ||
      /(skill|skills).{0,30}(trong|trong db|trong database|trong bảng|trong thư mục)/i.test(
        lower,
      ) ||
      /(sử\s*dụng|su\s*dung|thực\s*thi|thuc\s*thi|dùng|dung|chạy|chay|gọi|goi).{0,50}\bskill/i.test(
        lower,
      ) ||
      /\bfacebook_post_status\b/i.test(lower) ||
      /\brun_skill\b/i.test(lower) ||
      /\bskill\b.{0,120}(template|tái\s*sử|dùng\s*lại|đóng\s*gói|dùng\s*chung|_shared)/i.test(
        lower,
      ) ||
      /(template|tái\s*sử|dùng\s*lại|đóng\s*gói).{0,80}\bskill\b/i.test(lower) ||
      /(tối\s*ưu|toi\s*u).{0,80}\bskill\b/i.test(lower) ||
      /(tối\s*ưu|toi\s*u).{0,40}(thành|thanh).{0,20}template/i.test(lower) ||
      (/\bbootstrap\b/i.test(lower) && /\bskill\b/i.test(lower)) ||
      /\bskill\b.{0,120}\b(template|tai\s*su\s*dung|dung\s*lai|dong\s*goi)\b/i.test(t) ||
      /\b(toi\s*uu|luu\s*skill|tao\s*skill|package\s*skill)\b/i.test(t);
    if (skillsRegistryIntent) {
      return IntentType.TOOL_CALL;
    }

    // Greeting / smalltalk patterns
    const smalltalkPatterns = [
      /^(hi|hello|hey|xin chào|chào|ê|ơi|ok|thanks|cảm ơn|bye|tạm biệt)/,
      /^(có gì mới|bạn khỏe)/,
    ];
    if (wordCount <= 5 && smalltalkPatterns.some((p) => p.test(lower))) {
      return IntentType.SMALLTALK;
    }

    // Tool/action keywords
    const toolKeywords = [
      'skills_registry',
      'skill registry',
      'database',
      'databas',
      'trong db',
      'trong database',
      'liệt kê skill',
      'liet ke skill',
      'danh sách skill',
      'danh sach skill',
      'skill trong',
      'dùng skill',
      'dung skill',
      'gửi mail',
      'gửi email',
      'send email',
      'gmail',
      'lịch',
      'calendar',
      'cuộc họp',
      'meeting',
      'drive',
      'upload',
      'download',
      'tải',
      'sheet',
      'spreadsheet',
      'bảng tính',
      'facebook',
      'zalo',
      'telegram',
      'đăng bài',
      'post',
      'chạy lệnh',
      'exec',
      'terminal',
      'command',
      'trình duyệt',
      'browser',
      'mở web',
      'screenshot',
      'tìm kiếm',
      'search',
      'web',
      'cron',
      'lên lịch',
      'tự động',
      // Weather / forecast requests
      'thời tiết',
      'thoi tiet',
      'dự báo',
      'du bao',
      'weather',
      'forecast',
      // Delete / trash / destructive actions
      'xóa',
      'xoa',
      'delete',
      'remove',
      'rm ',
      'thùng rác',
      'thung rac',
      'trash',
      'emptytrash',
      'permanent',
      'vinh vien',
      'vĩnh viễn',
      'dọn sạch',
      'dọn rác',
    ];
    if (toolKeywords.some((kw) => lower.includes(kw))) {
      return IntentType.TOOL_CALL;
    }

    // Big data patterns
    const bigDataKeywords = [
      'tóm tắt',
      'summarize',
      'đọc file',
      'phân tích log',
      'tất cả email',
      'all emails',
      'toàn bộ',
      'hàng trăm',
    ];
    if (bigDataKeywords.some((kw) => lower.includes(kw))) {
      return IntentType.BIG_DATA;
    }

    // Reasoning patterns
    const reasoningKeywords = [
      'lập kế hoạch',
      'plan',
      'chiến lược',
      'strategy',
      'so sánh',
      'compare',
      'phân tích',
      'analyze',
      'tại sao',
      'why',
      'giải thích',
      'explain',
      'thiết kế',
      'design',
      'kiến trúc',
      'architecture',
    ];
    if (reasoningKeywords.some((kw) => lower.includes(kw))) {
      return IntentType.REASONING;
    }

    // Tin nhắn ngắn mà không match gì → smalltalk
    if (wordCount <= 8) {
      return IntentType.SMALLTALK;
    }

    // Default: coi như cần tool
    return IntentType.TOOL_CALL;
  }
}
