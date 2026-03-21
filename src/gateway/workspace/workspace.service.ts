import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { DEFAULT_BRAIN_DIR } from '../../config/brain-dir.config';
import {
  isOwnerSharedMarkdownFilename,
  type OwnerSharedMarkdownFile,
} from '../../config/owner-shared-markdown.config';

/** Luôn nối vào system prompt — không phụ thuộc file workspace (tránh bị override mất). */
const AGENT_NEXT_STEP_COMMANDS_GUIDANCE = `## Gợi ý lệnh bước tiếp theo (hệ thống)

Sau khi trả lời một **tác vụ phức tạp** (nhiều bước, nhiều tool, hoặc luồng còn có thể tiếp tục rõ ràng), hãy thêm một mục ngắn **"Gợi ý bước tiếp theo"** (hoặc tương đương):

- **2–5 gạch đầu dòng**; mỗi gạch = một hướng cụ thể + **câu lệnh gợi ý** user có thể copy/paste.
- Dùng đúng syntax chat/gateway:
  - Chạy thẳng tool + JSON: \`/tool_<code> <json>\` — ví dụ \`/tool_browser {"action":"navigate","url":"https://..."}\`, \`/tool_web_search {"query":"..."}\`.
  - Shared skill trên disk: \`/run_skill <skill_code> <json hoặc key=value>\`.
  - Chỉ định tool kèm lời thoại (lượt sau): đặt \`/browser\`, \`/web_search\`, … **trong câu** (một token, ví dụ \`/web_search\`, không viết \`/web search\`).
- **Không** bịa đã chạy tool; chỉ gợi ý thao tác thật sự hữu ích.

**Không** cần mục này nếu tác vụ đơn giản, đã kết thúc gọn, hoặc không có bước tiếp theo hợp lý.`;

/**
 * WorkspaceService quản lý thư mục workspace per-user (`BRAIN_DIR` trong .env, mặc định xem DEFAULT_BRAIN_DIR).
 *
 * Cấu trúc:
 *   $BRAIN_DIR/
 *   ├── _shared/                    ← SOUL, TOOLS, PROCESSES (chỉ _shared), AGENTS, browser_dom_presets/<domain>.json, skills/<skill_code>/
 *   └── <user_identifier>/          ← Workspace riêng mỗi user
 *       ├── workspace/
 *       │   ├── AGENTS.md           ← Copy/override từ _shared
 *       │   ├── IDENTITY.md         ← Riêng user
 *       │   ├── SOUL.md             ← Override từ _shared nếu muốn
 *       │   ├── USER.md             ← Riêng user
 *       │   ├── TOOLS.md            ← Override từ _shared nếu muốn
 *       │   ├── HEARTBEAT.md
 *       │   ├── MEMORY.md           ← Long-term memory
 *       │   └── memory/             ← Daily notes
 *       │       └── YYYY-MM-DD.md
 *       ├── sessions/               ← Chat history JSONL; per-thread tasks: sessions/<threadId>/tasks/
 *       │                             (task memory: _tasks_index.json + task-<ordinal>-<id>/state.json)
 *       ├── browser_dom_presets/    ← Optional: override _shared browser_dom_presets/<domain>.json
 *       └── skills/                 ← User-specific skills
 *
 * Logic kế thừa:
 * - **PROCESSES.md** chỉ đọc từ `_shared/` (một bản dùng chung; không có trong workspace từng user).
 * - System prompt (SOUL/AGENTS/TOOLS/IDENTITY): ưu tiên file trong
 *   `$BRAIN_DIR/<identifier>/workspace/` — nếu có nội dung thì **chỉ** dùng bản đó (không trộn `_shared`).
 * - Chỉ fallback `_shared` khi file user thiếu hoặc chỉ còn khoảng trắng (không áp dụng cho PROCESSES).
 * - `readWorkspaceFile` (skill/tool khác): vẫn user → fallback _shared.
 * - Khi tạo workspace mới, copy templates từ _shared
 * - Mỗi user hoàn toàn độc lập, có thể custom mọi thứ
 */
@Injectable()
export class WorkspaceService implements OnModuleInit {
  private readonly logger = new Logger(WorkspaceService.name);
  /** Gốc workspace — `ConfigService.get('BRAIN_DIR', DEFAULT_BRAIN_DIR)` đã resolve. */
  private brainDir: string;
  private sharedDir: string;

  /**
   * Cache system context to avoid re-reading multiple prompt files on every turn.
   * Invalidation is based on file mtime fingerprint + a short TTL.
   */
  private systemContextCache = new Map<
    string,
    { fingerprint: string; value: string; expiresAt: number }
  >();

  constructor(private readonly configService: ConfigService) {
    // Phải gán sớm trong constructor: module khác (vd. SkillsService.onModuleInit)
    // có thể đọc `runner.definition` trước khi WorkspaceService.onModuleInit chạy.
    this.brainDir = path.resolve(
      this.configService.get<string>('BRAIN_DIR', DEFAULT_BRAIN_DIR),
    );
    this.sharedDir = path.join(this.brainDir, '_shared');
  }

  onModuleInit() {
    fs.mkdirSync(this.sharedDir, { recursive: true });
    this.logger.log(`BRAIN_DIR (resolved): ${this.brainDir}`);
  }

  // ─── Paths ──────────────────────────────────────────────────────────

  /** Đường dẫn tuyệt đối tới gốc workspace (biến môi trường `BRAIN_DIR`). */
  getBrainDir(): string {
    return this.brainDir;
  }

  /** @deprecated Dùng `getBrainDir()`. */
  getHeartDir(): string {
    return this.getBrainDir();
  }

  getUserDir(identifier: string): string {
    return path.join(this.brainDir, identifier);
  }

  getUserWorkspaceDir(identifier: string): string {
    return path.join(this.getUserDir(identifier), 'workspace');
  }

  getUserSessionsDir(identifier: string): string {
    return path.join(this.getUserDir(identifier), 'sessions');
  }

  /** Thư mục lưu file/ảnh/video tải từ Telegram hoặc upload khác */
  getUserMediaIncomingDir(identifier: string): string {
    const dir = path.join(this.getUserDir(identifier), 'media', 'incoming');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  getUserCookiesDir(identifier: string): string {
    const dir = path.join(this.getUserDir(identifier), 'cookies');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  getUserCookieFilePath(identifier: string, domain: string): string {
    const dir = this.getUserCookiesDir(identifier);
    const cleaned = String(domain ?? '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//i, '')
      .replace(/[^a-z0-9.-]/g, '_');
    const fileName = `${cleaned || 'unknown'}.json`;
    return path.join(dir, fileName);
  }

  getUserSkillsDir(identifier: string): string {
    return path.join(this.getUserDir(identifier), 'skills');
  }

  getSharedSkillsDir(): string {
    const dir = path.join(this.sharedDir, 'skills');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Đường dẫn tuyệt đối tới `$BRAIN_DIR/_shared/<filename>` — chỉ các file trong
   * `OWNER_SHARED_MARKDOWN_FILES` (PROCESSES, AGENTS, HEARTBEAT, TOOLS, SOUL).
   */
  getSharedMarkdownPath(filename: OwnerSharedMarkdownFile | string): string {
    const f = String(filename ?? '').trim();
    if (!isOwnerSharedMarkdownFilename(f)) {
      throw new Error(`Invalid owner-shared markdown filename: ${filename}`);
    }
    return path.join(this.sharedDir, f);
  }

  readSharedMarkdown(filename: OwnerSharedMarkdownFile | string): string {
    const dest = this.getSharedMarkdownPath(filename);
    if (!fs.existsSync(dest)) return '';
    return fs.readFileSync(dest, 'utf-8');
  }

  /** Ghi đè toàn bộ file (chỉ gọi sau khi đã kiểm tra owner + hash ở tầng skill). */
  writeSharedMarkdown(filename: OwnerSharedMarkdownFile | string, content: string): void {
    fs.mkdirSync(this.sharedDir, { recursive: true });
    fs.writeFileSync(this.getSharedMarkdownPath(filename), content, 'utf-8');
  }

  /** Nối nội dung vào cuối file. */
  appendSharedMarkdown(filename: OwnerSharedMarkdownFile | string, content: string): void {
    fs.mkdirSync(this.sharedDir, { recursive: true });
    const dest = this.getSharedMarkdownPath(filename);
    const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf-8') : '';
    fs.writeFileSync(dest, `${existing}\n${content}`, 'utf-8');
  }

  /** @deprecated Dùng `getSharedMarkdownPath('PROCESSES.md')`. */
  getSharedProcessesPath(): string {
    return this.getSharedMarkdownPath('PROCESSES.md');
  }

  /** @deprecated Dùng `writeSharedMarkdown('PROCESSES.md', content)`. */
  writeSharedProcessesMd(content: string): void {
    this.writeSharedMarkdown('PROCESSES.md', content);
  }

  /** @deprecated Dùng `appendSharedMarkdown('PROCESSES.md', content)`. */
  appendSharedProcessesMd(content: string): void {
    this.appendSharedMarkdown('PROCESSES.md', content);
  }

  /** @deprecated Dùng `readSharedMarkdown('PROCESSES.md')`. */
  readSharedProcessesMd(): string {
    return this.readSharedMarkdown('PROCESSES.md');
  }

  /**
   * Per-domain JSON files: `$BRAIN_DIR/_shared/browser_dom_presets/<domain>.json`.
   * Only the matching domain file is read at runtime (not the whole folder contents as one blob).
   */
  getSharedBrowserDomPresetsDir(): string {
    const dir = path.join(this.sharedDir, 'browser_dom_presets');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Optional per-user overrides: `$BRAIN_DIR/<identifier>/browser_dom_presets/<domain>.json`
   * (same basename rules as shared). User file wins when present.
   */
  getUserBrowserDomPresetsDir(identifier: string): string {
    return path.join(this.getUserDir(identifier), 'browser_dom_presets');
  }

  /**
   * Skill packages live at $BRAIN_DIR/_shared/skills/<skill_code>/skill.json
   * (folder name = skill_code; replaces DB-only registry).
   */
  sanitizeSharedSkillCode(code: string): string | null {
    const s = String(code ?? '').trim();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(s)) return null;
    return s;
  }

  /** $BRAIN_DIR/_shared/skills/<skill_code>/ */
  getSharedSkillPackageDir(skillCode: string): string {
    const c = this.sanitizeSharedSkillCode(skillCode);
    if (!c) {
      throw new Error(
        'Invalid skill_code: use 1–128 chars [a-zA-Z0-9_-] only',
      );
    }
    return path.join(this.getSharedSkillsDir(), c);
  }

  /** $BRAIN_DIR/_shared/skills/<skill_code>/skill.json */
  getSharedSkillDefinitionPath(skillCode: string): string {
    return path.join(this.getSharedSkillPackageDir(skillCode), 'skill.json');
  }

  getUserMemoryDir(identifier: string): string {
    return path.join(this.getUserWorkspaceDir(identifier), 'memory');
  }

  /**
   * Create a new session note markdown file under:
   *   $BRAIN_DIR/<identifier>/sessions/<sessionId>.md
   *
   * Returns absolute file path.
   */
  createSessionNoteFile(
    identifier: string,
    sessionId?: string,
    content?: string,
  ): { sessionId: string; filePath: string } {
    const sessionsDir = this.getUserSessionsDir(identifier);
    const id =
      sessionId && /^[a-f0-9]{8,64}$/i.test(sessionId)
        ? sessionId
        : crypto
            .createHash('md5')
            .update(`${Date.now()}-${Math.random()}`)
            .digest('hex');
    const filePath = path.join(sessionsDir, `${id}.md`);
    fs.mkdirSync(sessionsDir, { recursive: true });

    const nowIso = new Date().toISOString();
    const initialContent =
      content ??
      `### Session: ${id}\n**Thời gian bắt đầu**: ${nowIso}\n\n---\n`;
    fs.writeFileSync(filePath, initialContent);

    return { sessionId: id, filePath };
  }

  // ─── Workspace Provisioning ─────────────────────────────────────────

  /**
   * Tạo workspace cho user mới nếu chưa có.
   * Copy templates từ _shared/ và tạo các file mặc định.
   */
  async ensureUserWorkspace(identifier: string): Promise<string> {
    const userDir = this.getUserDir(identifier);
    const workspaceDir = this.getUserWorkspaceDir(identifier);
    const sessionsDir = this.getUserSessionsDir(identifier);
    const skillsDir = this.getUserSkillsDir(identifier);
    const memoryDir = this.getUserMemoryDir(identifier);
    const cookiesDir = this.getUserCookiesDir(identifier);

    if (fs.existsSync(workspaceDir)) {
      return workspaceDir;
    }

    this.logger.log(`Provisioning workspace for user: ${identifier}`);

    // Tạo cấu trúc thư mục
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.mkdirSync(cookiesDir, { recursive: true });

    // Copy shared templates → user workspace
    const sharedFiles = [
      'AGENTS.md',
      'SOUL.md',
      'TOOLS.md',
      'HEARTBEAT.md',
    ];
    for (const file of sharedFiles) {
      const src = path.join(this.sharedDir, file);
      const dest = path.join(workspaceDir, file);
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
      }
    }

    // Tạo IDENTITY.md mặc định (riêng per-user)
    const identityPath = path.join(workspaceDir, 'IDENTITY.md');
    if (!fs.existsSync(identityPath)) {
      fs.writeFileSync(
        identityPath,
        `# IDENTITY.md\n\n` +
          `Agent của user: ${identifier}\n` +
          `Tạo lúc: ${new Date().toISOString()}\n`,
      );
    }

    // Tạo USER.md mặc định
    const userMdPath = path.join(workspaceDir, 'USER.md');
    if (!fs.existsSync(userMdPath)) {
      fs.writeFileSync(
        userMdPath,
        `# USER.md\n\n` +
          `- Name: \n` +
          `- Timezone: Asia/Ho_Chi_Minh\n` +
          `- Notes: \n`,
      );
    }

    this.logger.log(`Workspace provisioned: ${workspaceDir}`);
    return workspaceDir;
  }

  // ─── File Read (with fallback to _shared) ───────────────────────────

  /**
   * Đọc file workspace — ưu tiên user → fallback _shared.
   */
  readWorkspaceFile(identifier: string, filename: string): string | null {
    const userPath = path.join(this.getUserWorkspaceDir(identifier), filename);
    if (fs.existsSync(userPath)) {
      return fs.readFileSync(userPath, 'utf-8');
    }

    const sharedPath = path.join(this.sharedDir, filename);
    if (fs.existsSync(sharedPath)) {
      return fs.readFileSync(sharedPath, 'utf-8');
    }

    return null;
  }

  /**
   * Ghi file vào user workspace.
   */
  writeWorkspaceFile(
    identifier: string,
    filename: string,
    content: string,
  ): void {
    // Special-case: some skills may write session notes via write_file/append_file
    // using different path prefixes (e.g. "sessions/<id>.md" or
    // "workspace/sessions/<id>.md").
    // Always persist to the correct sibling directory: $BRAIN_DIR/<identifier>/sessions/.
    const sessionsDir = this.getUserSessionsDir(identifier);
    const normalized = filename.replace(/^\/+/, '');
    let relative: string | null = null;

    if (normalized.startsWith('sessions/')) {
      relative = normalized.replace(/^sessions\//, '');
    } else if (normalized.startsWith('workspace/sessions/')) {
      relative = normalized.replace(/^workspace\/sessions\//, '');
    } else if (normalized.includes('workspace/sessions/')) {
      relative = normalized.split('workspace/sessions/').pop() ?? null;
    }

    if (relative) {
      const dest = path.join(sessionsDir, relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
      return;
    }

    const dir = this.getUserWorkspaceDir(identifier);
    const dest = path.join(dir, filename);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }

  // ─── Memory ─────────────────────────────────────────────────────────

  /**
   * Đọc daily memory note.
   */
  readDailyMemory(identifier: string, date?: Date): string | null {
    const d = date || new Date();
    const filename = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`;
    const filePath = path.join(this.getUserMemoryDir(identifier), filename);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
  }

  /**
   * Append vào daily memory note.
   */
  appendDailyMemory(identifier: string, content: string, date?: Date): void {
    const d = date || new Date();
    const filename = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`;
    const memDir = this.getUserMemoryDir(identifier);
    fs.mkdirSync(memDir, { recursive: true });
    fs.appendFileSync(path.join(memDir, filename), content + '\n');
  }

  // ─── Session Files (JSONL) ──────────────────────────────────────────

  getThreadFilePath(identifier: string, threadId: string): string {
    return path.join(this.getUserSessionsDir(identifier), `${threadId}.jsonl`);
  }

  appendSessionEntry(
    identifier: string,
    threadId: string,
    entry: Record<string, unknown>,
  ): void {
    const dir = this.getUserSessionsDir(identifier);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${threadId}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  }

  // ─── Build Agent Context ────────────────────────────────────────────

  /**
   * Load toàn bộ context cho agent session:
   * IDENTITY + SOUL + AGENTS + TOOLS + PROCESSES + USER + MEMORY + daily + Drive
   *
   * **PROCESSES.md** luôn chỉ từ `_shared/` (không có bản per-user).
   *
   * Persona/tone (SOUL/AGENTS/TOOLS): **identifier-first** — file trong `$BRAIN_DIR/<identifier>/workspace/`
   * thắng hoàn toàn; `_shared` chỉ dùng khi không có bản user (hoặc user rỗng).
   */
  buildAgentSystemContext(identifier: string): string {
    const parts: string[] = [];

    // ─── Cache fingerprint (mtimes) ────────────────────────────────
    const userWorkspaceDir = this.getUserWorkspaceDir(identifier);
    const identityPath = path.join(userWorkspaceDir, 'IDENTITY.md');
    const sharedSoulPath = path.join(this.sharedDir, 'SOUL.md');
    const sharedAgentsPath = path.join(this.sharedDir, 'AGENTS.md');
    const sharedToolsPath = path.join(this.sharedDir, 'TOOLS.md');
    const sharedProcessesPath = path.join(this.sharedDir, 'PROCESSES.md');

    const userSoulPath = path.join(userWorkspaceDir, 'SOUL.md');
    const userAgentsPath = path.join(userWorkspaceDir, 'AGENTS.md');
    const userToolsPath = path.join(userWorkspaceDir, 'TOOLS.md');

    const userMdPath = path.join(userWorkspaceDir, 'USER.md');
    const memoryMdPath = path.join(userWorkspaceDir, 'MEMORY.md');
    const googleDriveMdPath = path.join(userWorkspaceDir, 'GOOGLE_DRIVE.md');

    const dailyMemoryFilePath = (() => {
      const d = new Date();
      const filename = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
        2,
        '0',
      )}-${String(d.getDate()).padStart(2, '0')}.md`;
      return path.join(this.getUserMemoryDir(identifier), filename);
    })();

    const statMtime = (p: string): number | null => {
      try {
        return fs.existsSync(p) ? fs.statSync(p).mtimeMs : null;
      } catch {
        return null;
      }
    };

    const fileMtimes = {
      identityPath: statMtime(identityPath),
      sharedSoulPath: statMtime(sharedSoulPath),
      sharedAgentsPath: statMtime(sharedAgentsPath),
      sharedToolsPath: statMtime(sharedToolsPath),
      sharedProcessesPath: statMtime(sharedProcessesPath),
      userSoulPath: statMtime(userSoulPath),
      userAgentsPath: statMtime(userAgentsPath),
      userToolsPath: statMtime(userToolsPath),
      userMdPath: statMtime(userMdPath),
      memoryMdPath: statMtime(memoryMdPath),
      googleDriveMdPath: statMtime(googleDriveMdPath),
      dailyMemoryFilePath: statMtime(dailyMemoryFilePath),
    };

    const fingerprint = crypto
      .createHash('sha1')
      .update(JSON.stringify(fileMtimes))
      .digest('hex');

    const now = Date.now();
    const cached = this.systemContextCache.get(identifier);
    if (cached && cached.fingerprint === fingerprint && cached.expiresAt > now) {
      return cached.value;
    }

    // Identifier-first: xưng hô / tính cách lấy từ workspace user; không trộn _shared
    // khi file user có nội dung (tránh hai “giọng” chồng lên nhau).
    this.appendUserWorkspaceOrShared(parts, identityPath, null);
    this.appendUserWorkspaceOrShared(parts, userSoulPath, sharedSoulPath);
    this.appendUserWorkspaceOrShared(parts, userAgentsPath, sharedAgentsPath);
    this.appendUserWorkspaceOrShared(parts, userToolsPath, sharedToolsPath);
    this.appendSharedProcessesOnly(parts, sharedProcessesPath);

    // USER.md / MEMORY / GOOGLE_DRIVE vẫn lấy từ workspace riêng của identifier
    const user = fs.existsSync(userMdPath) ? fs.readFileSync(userMdPath, 'utf-8') : null;
    if (user) parts.push(user);

    const memory = fs.existsSync(memoryMdPath)
      ? fs.readFileSync(memoryMdPath, 'utf-8')
      : null;
    if (memory) parts.push(`## Long-term Memory\n${memory}`);

    const daily = fs.existsSync(dailyMemoryFilePath)
      ? fs.readFileSync(dailyMemoryFilePath, 'utf-8')
      : null;
    if (daily) parts.push(`## Today's Notes\n${daily}`);

    const drive = fs.existsSync(googleDriveMdPath)
      ? fs.readFileSync(googleDriveMdPath, 'utf-8')
      : null;
    if (drive) {
      const readable = drive.replace(/<!--[\s\S]*?-->/g, '').trim();
      if (readable) parts.push(readable);
    }

    parts.push(AGENT_NEXT_STEP_COMMANDS_GUIDANCE);

    const value = parts.join('\n\n---\n\n');
    this.systemContextCache.set(identifier, {
      fingerprint,
      value,
      expiresAt: now + 30_000,
    });
    return value;
  }

  /**
   * Đọc `userPath` trước: nếu có nội dung (sau trim) thì chỉ đẩy bản đó.
   * Ngược lại fallback `sharedPath` (nếu có). `sharedPath` null = chỉ user (vd. IDENTITY.md).
   */
  private appendUserWorkspaceOrShared(
    parts: string[],
    userPath: string,
    sharedPath: string | null,
  ): void {
    if (fs.existsSync(userPath)) {
      const u = fs.readFileSync(userPath, 'utf-8').trim();
      if (u) {
        parts.push(u);
        return;
      }
    }
    if (sharedPath && fs.existsSync(sharedPath)) {
      const s = fs.readFileSync(sharedPath, 'utf-8').trim();
      if (s) parts.push(s);
    }
  }

  /** PROCESSES.md: chỉ `_shared/`, không có override per-user. */
  private appendSharedProcessesOnly(parts: string[], sharedPath: string): void {
    if (fs.existsSync(sharedPath)) {
      const s = fs.readFileSync(sharedPath, 'utf-8').trim();
      if (s) parts.push(s);
    }
  }

  // ─── Skill Dirs (cho ClawhubLoader) ─────────────────────────────────

  /**
   * Trả về danh sách thư mục skills cho user (user-specific + shared).
   */
  getSkillDirs(identifier: string): string[] {
    const dirs: string[] = [];
    const userSkills = this.getUserSkillsDir(identifier);
    if (fs.existsSync(userSkills)) dirs.push(userSkills);

    const sharedSkills = path.join(this.sharedDir, 'skills');
    if (fs.existsSync(sharedSkills)) dirs.push(sharedSkills);

    return dirs;
  }
}
