/**
 * ClawhHub skill interfaces.
 *
 * ClawhHub skills là markdown-based instructions (SKILL.md), không phải executable code.
 * Chúng được inject vào system prompt để LLM đọc và follow.
 *
 * Có 2 cách dùng ClawhHub skills trong NestJS:
 *
 * 1. Prompt Injection: parse SKILL.md → inject vào system prompt
 *    LLM tự quyết định khi nào dùng, dùng built-in tools (exec, browser...) để thực thi
 *
 * 2. Hybrid: parse SKILL.md → tạo IToolDefinitionForLLM
 *    LLM gọi skill → system inject instructions vào context → LLM follow
 */

export interface IClawhubSkillFrontmatter {
  name: string;
  description?: string;
  homepage?: string;
  metadata?: {
    openclaw?: {
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
    };
  };
  /** Cho phép user gọi trực tiếp qua slash command */
  'user-invocable'?: boolean;
  /** Ẩn khỏi model prompt, chỉ dùng khi user gọi */
  'disable-model-invocation'?: boolean;
}

export interface IClawhubSkillEntry {
  /** Tên skill (từ frontmatter.name hoặc tên folder) */
  name: string;
  description: string;
  /** Đường dẫn tới folder chứa SKILL.md */
  dirPath: string;
  /** Nội dung đầy đủ SKILL.md */
  rawContent: string;
  /** Frontmatter đã parse */
  frontmatter: IClawhubSkillFrontmatter;
  /** Body (phần markdown sau frontmatter) */
  instructions: string;
  /** Nguồn: bundled, workspace, clawhub, managed */
  source: 'bundled' | 'workspace' | 'clawhub' | 'managed';
}

export interface IClawhubInstallResult {
  success: boolean;
  skill?: IClawhubSkillEntry;
  error?: string;
}

export interface IClawhubSearchResult {
  name: string;
  description: string;
  version: string;
  downloads?: number;
  tags?: string[];
}
