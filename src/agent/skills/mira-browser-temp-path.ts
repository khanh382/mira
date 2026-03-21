import * as path from 'path';
import { tmpdir } from 'os';

/**
 * Một segment tên thư mục an toàn (tránh ký tự đặc biệt).
 */
export function sanitizeMiraBrowserSegment(raw: string, maxLen: number): string {
  const s = String(raw ?? '')
    .replace(/[^a-zA-Z0-9_-]/gi, '_')
    .slice(0, maxLen)
    .replace(/^_+|_+$/g, '');
  return s || '_';
}

/**
 * Thư mục gốc cho browser với `browserDebugScope: 'temp'`.
 *
 * Cấu trúc: `<tmpdir>/mira-browser/u<userId>/<runId|threadId>`
 * — mỗi user một nhánh; cleanup của user A không chạm user B;
 * — cùng user, hai tác vụ song song cần `runId` khác nhau (pipeline đã set).
 */
export function getMiraBrowserTempBaseDir(ctx: {
  userId: number;
  runId?: string;
  threadId: string;
}): string {
  const userSeg = `u${Number(ctx.userId)}`;
  const sessionRaw = String(ctx.runId ?? ctx.threadId ?? 'run').trim() || 'run';
  const sessionSeg = sanitizeMiraBrowserSegment(sessionRaw, 96);
  return path.join(tmpdir(), 'mira-browser', userSeg, sessionSeg);
}
