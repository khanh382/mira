import { sanitizeLlmDisplayLeakage } from './llm-output-sanitize';

/**
 * Chuẩn hóa nội dung assistant khi gửi **plain text** (Telegram, Zalo, Discord, WebChat…):
 * - Lọc token / reasoning / XML rò rỉ từ model (DeepSeek-R1, v.v.).
 * - Gỡ Markdown **bold** (thường không bật parse_mode / hiển thị ký tự rối).
 * - Cắt khối "Gợi ý nhanh" / "Ghi chú nhanh" / câu hỏi đuôi "điều chỉnh tên hoặc xưng hô".
 */
export function sanitizeAssistantOutboundPlainText(text: string): string {
  return stripTrailingQuickAsideBlocks(
    plainTextStripMarkdownBold(sanitizeLlmDisplayLeakage(text)),
  );
}

function plainTextStripMarkdownBold(text: string): string {
  let s = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*\*/g, '');
  return s;
}

function stripTrailingQuickAsideBlocks(text: string): string {
  let s = text;
  const blocks = [
    /(?:^|\r?\n)\s*Gợi ý nhanh\s*:?\s*\r?\n[\s\S]*$/im,
    /(?:^|\r?\n)\s*Ghi chú nhanh\s*:?\s*\r?\n[\s\S]*$/im,
    // "Cần em điều chỉnh tên hoặc cách xưng hô không ạ?" — không cần sau câu hỏi tên thường
    /\r?\n+\s*Cần em[^.\n]{0,160}(?:điều chỉnh|chỉnh\s*đổi|chỉnh)[^.\n]{0,160}(?:tên|xưng\s*hô)[\s\S]*$/im,
  ];
  for (const re of blocks) {
    s = s.replace(re, '');
  }
  return s.trimEnd();
}
