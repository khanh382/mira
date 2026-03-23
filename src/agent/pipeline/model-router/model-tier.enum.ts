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
 *
 * Local LLM (Ollama / LM Studio): xếp CUỐI trong CHEAP và SKILL tier —
 * dùng làm offline fallback khi không có cloud provider.
 * Model name mặc định: ollama/llama3.2, lmstudio/local-model.
 * Ghi đè bằng DEFAULT_MODEL hoặc CONTEXT_FOCUS_MODEL nếu muốn dùng model khác.
 */
export const MODEL_PRIORITY: Record<ModelTier, ModelCandidate[]> = {
  [ModelTier.CHEAP]: [
    {
      id: 'deepseek/deepseek-chat',
      provider: 'deepseek',
      model: 'deepseek-chat',
      openrouterModel: 'deepseek/deepseek-chat',
      tier: ModelTier.CHEAP,
    },
    {
      id: 'openai/gpt-4o-mini',
      provider: 'openai',
      model: 'gpt-4o-mini',
      openrouterModel: 'openai/gpt-4o-mini',
      tier: ModelTier.CHEAP,
    },
    // Local fallbacks — chỉ dùng khi không có cloud provider
    {
      id: 'ollama/llama3.2',
      provider: 'ollama',
      model: 'llama3.2',
      tier: ModelTier.CHEAP,
    },
    {
      id: 'lmstudio/local-model',
      provider: 'lmstudio',
      model: 'local-model',
      tier: ModelTier.CHEAP,
    },
  ],

  [ModelTier.SKILL]: [
    {
      id: 'deepseek/deepseek-chat',
      provider: 'deepseek',
      model: 'deepseek-chat',
      openrouterModel: 'deepseek/deepseek-chat',
      tier: ModelTier.SKILL,
    },
    {
      id: 'openai/gpt-4o',
      provider: 'openai',
      model: 'gpt-4o',
      openrouterModel: 'openai/gpt-4o',
      tier: ModelTier.SKILL,
    },
    // Local fallbacks
    {
      id: 'ollama/llama3.2',
      provider: 'ollama',
      model: 'llama3.2',
      tier: ModelTier.SKILL,
    },
    {
      id: 'lmstudio/local-model',
      provider: 'lmstudio',
      model: 'local-model',
      tier: ModelTier.SKILL,
    },
  ],

  [ModelTier.PROCESSOR]: [
    {
      id: 'deepseek/deepseek-chat',
      provider: 'deepseek',
      model: 'deepseek-chat',
      openrouterModel: 'deepseek/deepseek-chat',
      tier: ModelTier.PROCESSOR,
    },
    // Ollama local — phù hợp xử lý context dài offline
    {
      id: 'ollama/llama3.2',
      provider: 'ollama',
      model: 'llama3.2',
      tier: ModelTier.PROCESSOR,
    },
    {
      id: 'lmstudio/local-model',
      provider: 'lmstudio',
      model: 'local-model',
      tier: ModelTier.PROCESSOR,
    },
  ],

  [ModelTier.EXPERT]: [
    {
      id: 'deepseek/deepseek-reasoner',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      openrouterModel: 'deepseek/deepseek-r1',
      tier: ModelTier.EXPERT,
    },
    {
      id: 'openai/gpt-4o',
      provider: 'openai',
      model: 'gpt-4o',
      openrouterModel: 'openai/gpt-4o',
      tier: ModelTier.EXPERT,
    },
    {
      id: 'deepseek/deepseek-chat',
      provider: 'deepseek',
      model: 'deepseek-chat',
      openrouterModel: 'deepseek/deepseek-chat',
      tier: ModelTier.EXPERT,
    },
    // Local fallback cho expert tier (năng lực hạn chế nhưng vẫn hoạt động offline)
    {
      id: 'ollama/llama3.2',
      provider: 'ollama',
      model: 'llama3.2',
      tier: ModelTier.EXPERT,
    },
  ],
};
