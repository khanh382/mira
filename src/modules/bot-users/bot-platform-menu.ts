/**
 * Lệnh hệ thống hiển thị trên Telegram (setMyCommands), Discord (slash),
 * và gợi ý nội dung /menu + Zalo quick reply.
 * Code tools: /list_skills. Skill thư mục shared: /list_other_skills.
 * Agent: /agents (system + OpenClaw đã đăng ký).
 */

export type BotMenuEntry = {
  /** Telegram BotCommand.command + Discord slash name (a-z0-9_) */
  command: string;
  /** Telegram: 3–256 ký tự */
  telegramDescription: string;
  /** Discord: tối đa ~100 ký tự */
  discordDescription: string;
};

export const SYSTEM_BOT_MENU_ENTRIES: readonly BotMenuEntry[] = [
  {
    command: 'menu',
    telegramDescription:
      'Danh sách lệnh nhanh và gợi ý (cùng nội dung /menu)',
    discordDescription: 'Hiển thị các lệnh hệ thống và gợi ý',
  },
  {
    command: 'agents',
    telegramDescription:
      'Agent system + OpenClaw của bạn; /oa use <id> để chọn OpenClaw',
    discordDescription: 'Liệt kê agent system + OpenClaw (chủ bot)',
  },
  {
    command: 'workflows',
    telegramDescription:
      'Hiển thị workflow hiện tại, bấm để xem mô tả và cách gọi',
    discordDescription: 'Liệt kê workflow hiện có và hướng dẫn gọi',
  },
  {
    command: 'list_skills',
    telegramDescription:
      'Liệt kê mã tool code (@RegisterSkill) — không gồm gói $BRAIN_DIR/_shared/skills',
    discordDescription: 'Liệt kê tool code đăng ký trong backend',
  },
  {
    command: 'list_other_skills',
    telegramDescription:
      'Liệt kê skill trong thư mục $BRAIN_DIR/_shared/skills (gói skill.json)',
    discordDescription: 'Skill trong $BRAIN_DIR/_shared/skills (owner)',
  },
  {
    command: 'new_session',
    telegramDescription: 'Tạo phiên chat mới (reset thread)',
    discordDescription: 'Tạo session chat mới',
  },
  {
    command: 'brain_tree',
    telegramDescription:
      'Một cấp từ gốc brain; /brain_read [path] = list thư mục hoặc đọc file',
    discordDescription: 'Cây brain một cấp; /brain_read liệt kê hoặc đọc file',
  },
  {
    command: 'stop',
    telegramDescription: 'Tạm dừng tác vụ cho tài khoản của bạn',
    discordDescription: 'Dừng tác vụ của bạn',
  },
  {
    command: 'resume',
    telegramDescription: 'Bật lại xử lý tác vụ cho bạn',
    discordDescription: 'Bật lại xử lý tác vụ',
  },
  {
    command: 'stopall',
    telegramDescription: 'Dừng toàn hệ thống (owner/colleague)',
    discordDescription: 'Dừng toàn bộ hệ thống (owner)',
  },
  {
    command: 'resumeall',
    telegramDescription: 'Bật lại toàn hệ thống sau stopall (owner)',
    discordDescription: 'Bật lại hệ thống (owner)',
  },
  {
    command: 'cron_manage',
    telegramDescription: '/tool_cron_manage {"action":"add_n8n",...} — tạo lịch gọi workflow n8n (owner)',
    discordDescription: 'Tạo lịch gọi workflow n8n (owner)',
  },
];

/** Zalo quick reply: title ngắn (≤30), payload gửi lại như tin nhắn text */
export const ZALO_QUICK_MENU_BUTTONS: readonly {
  title: string;
  payload: string;
}[] = [
  { title: '/agents', payload: '/agents' },
  { title: '/list_skills', payload: '/list_skills' },
  { title: '/list_other', payload: '/list_other_skills' },
  { title: '/new_session', payload: '/new_session' },
  { title: '/stop', payload: '/stop' },
];

export function buildMenuHelpText(): string {
  const lines = [
    '📋 Lệnh hệ thống (gõ / trong chat hoặc chọn từ menu bot)',
    '',
    ...SYSTEM_BOT_MENU_ENTRIES.filter((e) => e.command !== 'menu').map(
      (e) => `/${e.command} — ${e.telegramDescription}`,
    ),
    '',
    'Agent (system + OpenClaw — chỉ chủ bot):',
    '- /agents hoặc /oa list — xem agent hệ thống và OpenClaw đã đăng ký',
    '- /oa use system — về agent hệ thống',
    '- /oa use <oa_id> — chọn OpenClaw; /oa new — phiên OpenClaw mới',
    '',
    'Khác:',
    '- /workflows — xem danh sách workflow; (Telegram) có nút bấm xem chi tiết từng workflow',
    '- /brain_read [đường-dẫn] — thư mục: liệt kê con một cấp; file: nội dung. Bỏ trống = gốc user',
    '- /clean_media_incoming — xóa nội dung media/incoming (không nằm trong menu bot)',
    '- /list_tools — giống /list_skills (mã tool backend)',
    '- /tool_cron_manage {"action":"add_n8n",...} — tạo lịch gọi workflow n8n (owner)',
    '- /run_skill <mã> <json hoặc key=value> — chạy gói trong $BRAIN_DIR/_shared/skills/',
    '- /delete_skill <mã> — xóa gói (owner)',
    '- /update_skill <mã> <json patch> — sửa skill.json (owner)',
    '- /tool_<code> <json> — ví dụ /tool_browser {"action":"status"}',
    '- Trong câu: /browser, /web_search … để gợi ý tool cho AI',
    '',
    'Chi tiết: $BRAIN_DIR/_shared/SYSTEM_COMMANDS.md',
  ];
  return lines.join('\n');
}
