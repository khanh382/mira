import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

/**
 * WorkspaceService quản lý thư mục heart/ per-user.
 *
 * Cấu trúc:
 *   heart/
 *   ├── _shared/                    ← Tài nguyên dùng chung (SOUL.md, TOOLS.md, AGENTS.md, skills/)
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
 *       ├── sessions/               ← Chat history JSONL
 *       └── skills/                 ← User-specific skills
 *
 * Logic kế thừa:
 * - Khi đọc file, ưu tiên user workspace → fallback _shared
 * - Khi tạo workspace mới, copy templates từ _shared
 * - Mỗi user hoàn toàn độc lập, có thể custom mọi thứ
 */
@Injectable()
export class WorkspaceService implements OnModuleInit {
  private readonly logger = new Logger(WorkspaceService.name);
  private heartDir: string;
  private sharedDir: string;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.heartDir = path.resolve(
      this.configService.get('BRAIN_DIR', './heart'),
    );
    this.sharedDir = path.join(this.heartDir, '_shared');

    fs.mkdirSync(this.sharedDir, { recursive: true });
    this.logger.log(`Heart directory: ${this.heartDir}`);
  }

  // ─── Paths ──────────────────────────────────────────────────────────

  getHeartDir(): string {
    return this.heartDir;
  }

  getUserDir(identifier: string): string {
    return path.join(this.heartDir, identifier);
  }

  getUserWorkspaceDir(identifier: string): string {
    return path.join(this.getUserDir(identifier), 'workspace');
  }

  getUserSessionsDir(identifier: string): string {
    return path.join(this.getUserDir(identifier), 'sessions');
  }

  getUserSkillsDir(identifier: string): string {
    return path.join(this.getUserDir(identifier), 'skills');
  }

  getUserMemoryDir(identifier: string): string {
    return path.join(this.getUserWorkspaceDir(identifier), 'memory');
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

    if (fs.existsSync(workspaceDir)) {
      return workspaceDir;
    }

    this.logger.log(`Provisioning workspace for user: ${identifier}`);

    // Tạo cấu trúc thư mục
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(memoryDir, { recursive: true });

    // Copy shared templates → user workspace
    const sharedFiles = ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'HEARTBEAT.md'];
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
  writeWorkspaceFile(identifier: string, filename: string, content: string): void {
    const dir = this.getUserWorkspaceDir(identifier);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content);
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

  appendSessionEntry(identifier: string, threadId: string, entry: Record<string, unknown>): void {
    const dir = this.getUserSessionsDir(identifier);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${threadId}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  }

  // ─── Build Agent Context ────────────────────────────────────────────

  /**
   * Load toàn bộ context cho agent session:
   * SOUL + USER + AGENTS + MEMORY + daily memory
   */
  buildAgentSystemContext(identifier: string): string {
    const parts: string[] = [];

    const soul = this.readWorkspaceFile(identifier, 'SOUL.md');
    if (soul) parts.push(soul);

    const user = this.readWorkspaceFile(identifier, 'USER.md');
    if (user) parts.push(user);

    const agents = this.readWorkspaceFile(identifier, 'AGENTS.md');
    if (agents) parts.push(agents);

    const memory = this.readWorkspaceFile(identifier, 'MEMORY.md');
    if (memory) parts.push(`## Long-term Memory\n${memory}`);

    const daily = this.readDailyMemory(identifier);
    if (daily) parts.push(`## Today's Notes\n${daily}`);

    return parts.join('\n\n---\n\n');
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
