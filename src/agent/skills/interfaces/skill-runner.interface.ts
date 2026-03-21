/**
 * Skill system interfaces — hỗ trợ 2 loại skill:
 *
 * 1. CodeSkill (ISkillRunner)  → NestJS Injectable với execute()
 *    Dùng cho: web_search, exec, browser, tts...
 *    LLM gọi qua function calling → execute() chạy logic → trả ISkillResult
 *
 * 2. PromptSkill (IPromptSkill) → Markdown instructions (ClawhHub compatible)
 *    Dùng cho: skills từ ClawhHub, workspace skills
 *    Được inject vào system prompt → LLM tự đọc và follow instructions
 */

import { ModelTier } from '../../../agent/pipeline/model-router/model-tier.enum';

// ─── Skill Categories ─────────────────────────────────────────────────

export enum SkillCategory {
  WEB = 'web',
  RUNTIME = 'runtime',
  BROWSER = 'browser',
  MEDIA = 'media',
  MEMORY = 'memory',
  MESSAGING = 'messaging',
  SESSIONS = 'sessions',
  FILESYSTEM = 'filesystem',
  GOOGLE = 'google',
  CUSTOM = 'custom',
  CLAWHUB = 'clawhub',
}

export enum SkillType {
  CODE = 'code',
  PROMPT = 'prompt',
}

// ─── Shared ───────────────────────────────────────────────────────────

export interface ISkillDefinition {
  code: string;
  name: string;
  description: string;
  category: SkillCategory;
  type: SkillType;
  parametersSchema?: Record<string, unknown>;
  /** Cờ owner-only: chỉ user level=owner mới dùng được */
  ownerOnly?: boolean;
  /** Yêu cầu model tier tối thiểu để chạy skill này (default: CHEAP) */
  minModelTier?: ModelTier;
}

// ─── Code-based Skill (function calling) ──────────────────────────────

export interface ISkillExecutionContext {
  userId: number;
  threadId: string;
  /** Một lần chạy pipeline (vd agent loop) — dùng gom browser_debug / skill_draft một thư mục */
  runId?: string;
  actorTelegramId?: string;
  parameters: Record<string, unknown>;
  /** Abort signal cho long-running skills */
  signal?: AbortSignal;
}

export interface ISkillResult {
  success: boolean;
  data?: unknown;
  error?: string;
  metadata?: {
    durationMs: number;
    [key: string]: unknown;
  };
}

export interface ISkillRunner {
  readonly definition: ISkillDefinition;

  execute(context: ISkillExecutionContext): Promise<ISkillResult>;

  validate?(parameters: Record<string, unknown>): boolean;
}

// ─── Prompt-based Skill (ClawhHub / markdown instructions) ────────────

export interface IPromptSkillMetadata {
  requires?: {
    bins?: string[];
    env?: string[];
    config?: string[];
  };
  primaryEnv?: string;
  install?: Array<{
    kind: string;
    package: string;
    bins?: string[];
    label?: string;
  }>;
}

export interface IPromptSkill {
  readonly definition: ISkillDefinition;

  /** Nội dung SKILL.md (body markdown, không tính frontmatter) */
  readonly instructions: string;

  /** Metadata parsed từ frontmatter */
  readonly metadata: IPromptSkillMetadata;

  /** Source: bundled, workspace, clawhub, plugin */
  readonly source: string;

  /** Kiểm tra requirements đã đủ chưa */
  checkRequirements?(): { satisfied: boolean; missing: string[] };
}

// ─── Tool definition format cho LLM (function calling schema) ─────────

export interface IToolDefinitionForLLM {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
