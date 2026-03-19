/**
 * ModelTier — phân loại mức model theo tác vụ.
 *
 * CHEAP     (The Grunt)     — Phân loại intent, chào hỏi, câu hỏi ngắn
 * SKILL     (The Artisan)   — Gọi Tool, viết code, GOG CLI, Playwright
 * PROCESSOR (The Processor) — Xử lý dữ liệu lớn, tóm tắt, context dài
 * EXPERT    (The Architect)  — Suy luận đa bước, lập kế hoạch phức tạp
 */
export enum ModelTier {
  CHEAP = 'cheap',
  SKILL = 'skill',
  PROCESSOR = 'processor',
  EXPERT = 'expert',
}

/**
 * Intent classification — kết quả phân loại ý định user.
 */
export enum IntentType {
  SMALLTALK = 'smalltalk',
  TOOL_CALL = 'tool_call',
  BIG_DATA = 'big_data',
  REASONING = 'reasoning',
}

/**
 * Model definition với provider + model name + tier.
 */
export interface ModelCandidate {
  id: string;
  provider: string;
  model: string;
  tier: ModelTier;
  /** Full model ID for OpenRouter (e.g. "deepseek/deepseek-chat") */
  openrouterModel?: string;
}

/**
 * Bảng model ưu tiên theo tier.
 * Mỗi tier có danh sách models xếp theo thứ tự ưu tiên (đầu = ưu tiên nhất).
 *
 * Fallback: nếu model ưu tiên không có API key → dùng model tiếp theo.
 * OpenRouter: dùng làm universal fallback — nếu có openrouter key,
 * mọi model đều khả dụng qua openrouter.
 */
export const MODEL_PRIORITY: Record<ModelTier, ModelCandidate[]> = {
  [ModelTier.CHEAP]: [
    { id: 'deepseek/deepseek-chat', provider: 'deepseek', model: 'deepseek-chat', openrouterModel: 'deepseek/deepseek-chat', tier: ModelTier.CHEAP },
    { id: 'gemini/gemini-1.5-flash', provider: 'gemini', model: 'gemini-1.5-flash', openrouterModel: 'google/gemini-flash-1.5', tier: ModelTier.CHEAP },
    { id: 'openai/gpt-4o-mini', provider: 'openai', model: 'gpt-4o-mini', openrouterModel: 'openai/gpt-4o-mini', tier: ModelTier.CHEAP },
  ],

  [ModelTier.SKILL]: [
    { id: 'anthropic/claude-3.5-sonnet', provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', openrouterModel: 'anthropic/claude-3.5-sonnet', tier: ModelTier.SKILL },
    { id: 'openai/gpt-4o', provider: 'openai', model: 'gpt-4o', openrouterModel: 'openai/gpt-4o', tier: ModelTier.SKILL },
    { id: 'deepseek/deepseek-chat', provider: 'deepseek', model: 'deepseek-chat', openrouterModel: 'deepseek/deepseek-chat', tier: ModelTier.SKILL },
  ],

  [ModelTier.PROCESSOR]: [
    { id: 'gemini/gemini-1.5-flash', provider: 'gemini', model: 'gemini-1.5-flash', openrouterModel: 'google/gemini-flash-1.5', tier: ModelTier.PROCESSOR },
    { id: 'gemini/gemini-1.5-pro', provider: 'gemini', model: 'gemini-1.5-pro', openrouterModel: 'google/gemini-pro-1.5', tier: ModelTier.PROCESSOR },
    { id: 'deepseek/deepseek-chat', provider: 'deepseek', model: 'deepseek-chat', openrouterModel: 'deepseek/deepseek-chat', tier: ModelTier.PROCESSOR },
  ],

  [ModelTier.EXPERT]: [
    { id: 'deepseek/deepseek-reasoner', provider: 'deepseek', model: 'deepseek-reasoner', openrouterModel: 'deepseek/deepseek-r1', tier: ModelTier.EXPERT },
    { id: 'openai/gpt-4o', provider: 'openai', model: 'gpt-4o', openrouterModel: 'openai/gpt-4o', tier: ModelTier.EXPERT },
    { id: 'anthropic/claude-3.5-sonnet', provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', openrouterModel: 'anthropic/claude-3.5-sonnet', tier: ModelTier.EXPERT },
  ],
};
