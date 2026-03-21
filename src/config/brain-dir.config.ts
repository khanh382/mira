import * as path from 'path';

/**
 * Giá trị mặc định khi biến môi trường `BRAIN_DIR` không được set.
 * Thư mục workspace agent (per-user + `_shared/`) — override bằng `.env`.
 */
export const DEFAULT_BRAIN_DIR = './heart';

/**
 * Tên thư mục cuối sau khi resolve `BRAIN_DIR` (vd. `heart`, `brain`).
 */
export function getResolvedBrainDirBasename(): string {
  const d = process.env.BRAIN_DIR?.trim() || DEFAULT_BRAIN_DIR;
  return path.basename(path.resolve(d));
}

/**
 * Regex nhận diện user nhắc tới shared skills (theo tên folder hiện tại + legacy `heart`).
 */
export function getSharedSkillsPathMentionRegex(): RegExp {
  const bases = new Set(['heart', getResolvedBrainDirBasename()]);
  const escaped = [...bases].map((b) =>
    b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  return new RegExp(
    `(?:${escaped.join('|')})/_shared/skills|_shared/skills|shared/skills`,
    'i',
  );
}
