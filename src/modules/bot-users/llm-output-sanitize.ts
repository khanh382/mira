/**
 * Lọc nội dung rò rỉ từ model (DeepSeek-R1, model rẻ, v.v.): khối reasoning,
 * token đặc dụ <|...|>, mảnh XML tool — trước khi lưu DB hoặc hiển thị user.
 */
export function sanitizeLlmDisplayLeakage(text: string): string {
  if (!text) return text;
  let s = text;

  // DeepSeek-R1: `think` … `think` (hoặc `think` … `/think`)
  s = s.replace(/`think`[\s\S]*?`(?:think|\/think)`/gi, '');

  // Token kiểu <|think|> … <|/think|> rồi các <|name|> ngắn
  s = s.replace(/<\|[^|]{1,120}\|>/g, '');

  // Một số model dùng ký tự fullwidth
  s = s.replace(/<｜[^｜]{0,120}｜>/g, '');

  // Chuỗi XML / tool gọi lẫn vào completion
  s = s.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '');
  s = s.replace(/<invoke[^>]*>[\s\S]*?<\/invoke>/gi, '');
  s = s.replace(/<tool_use>[\s\S]*?<\/tool_use>/gi, '');
  s = s.replace(/<available_skills>[\s\S]*?<\/available_skills>/gi, '');

  s = s.replace(/\n{4,}/g, '\n\n\n');
  return s.trim();
}
