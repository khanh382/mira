/**
 * Các file markdown chỉ nằm dưới `$BRAIN_DIR/_shared/` (không ghi qua memory_write vào workspace user).
 * Chỉ **owner** được cập nhật qua `memory_write` (read + ifMatchSha256 + write/append).
 */
export const OWNER_SHARED_MARKDOWN_FILES = [
  'PROCESSES.md',
  'AGENTS.md',
  'HEARTBEAT.md',
  'TOOLS.md',
  'SOUL.md',
] as const;

export type OwnerSharedMarkdownFile =
  (typeof OWNER_SHARED_MARKDOWN_FILES)[number];

export function isOwnerSharedMarkdownFilename(filename: string): boolean {
  const f = filename.trim();
  return (OWNER_SHARED_MARKDOWN_FILES as readonly string[]).includes(f);
}
