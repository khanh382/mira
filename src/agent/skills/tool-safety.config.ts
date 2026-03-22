/**
 * Tool "Safe" (read-only) cho colleague — giảm rủi ro prompt injection gọi ghi/xóa/đăng.
 * Owner: không lọc theo danh sách này (trừ SSRF ở web_fetch trừ khi bypass).
 */
export const COLLEAGUE_SAFE_TOOL_CODES = new Set<string>([
  'web_fetch',
  'web_search',
  'memory_search',
  'memory_get',
  'threads_list',
  'thread_history',
  'file_read',
  'pdf_read',
  'image_understand',
]);

export function isColleagueSafeTool(skillCode: string): boolean {
  return COLLEAGUE_SAFE_TOOL_CODES.has(skillCode);
}
