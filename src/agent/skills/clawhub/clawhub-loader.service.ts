import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import {
  IClawhubSkillEntry,
  IClawhubSkillFrontmatter,
  IClawhubInstallResult,
} from './interfaces/clawhub-skill.interface';

/**
 * ClawhubLoaderService — load, parse và quản lý ClawhHub prompt-based skills.
 *
 * Skills được load từ nhiều nguồn (ưu tiên cao → thấp):
 * 1. workspace/skills/   — skills trong workspace hiện tại
 * 2. managed skills dir  — ~/.mira/skills/ (skills cài qua clawhub CLI)
 * 3. bundled skills      — skills đi kèm backend
 *
 * Mỗi skill là 1 folder chứa SKILL.md với YAML frontmatter + markdown body.
 */
@Injectable()
export class ClawhubLoaderService implements OnModuleInit {
  private readonly logger = new Logger(ClawhubLoaderService.name);
  private readonly skills = new Map<string, IClawhubSkillEntry>();

  private readonly skillDirs: Array<{ dir: string; source: IClawhubSkillEntry['source'] }>;

  constructor(private readonly configService: ConfigService) {
    const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
    const workspaceDir = this.configService.get('AGENT_WORKSPACE', process.cwd());

    this.skillDirs = [
      { dir: path.join(__dirname, '../../../../skills'), source: 'bundled' },
      { dir: path.join(home, '.mira', 'skills'), source: 'managed' },
      { dir: path.join(workspaceDir, 'skills'), source: 'workspace' },
    ];
  }

  async onModuleInit() {
    await this.loadAllSkills();
  }

  // ─── Load & Parse ───────────────────────────────────────────────────

  async loadAllSkills(): Promise<void> {
    this.skills.clear();

    for (const { dir, source } of this.skillDirs) {
      if (!fs.existsSync(dir)) continue;

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = path.join(dir, entry.name);
        const skillMdPath = path.join(skillDir, 'SKILL.md');

        if (!fs.existsSync(skillMdPath)) continue;

        try {
          const raw = fs.readFileSync(skillMdPath, 'utf-8');
          const parsed = this.parseSkillMd(raw, entry.name, skillDir, source);
          // Higher priority sources overwrite lower
          this.skills.set(parsed.name, parsed);
          this.logger.debug(`Loaded skill: ${parsed.name} (${source})`);
        } catch (error) {
          this.logger.warn(`Failed to parse ${skillMdPath}: ${error.message}`);
        }
      }
    }

    this.logger.log(`Loaded ${this.skills.size} ClawhHub/prompt skills`);
  }

  private parseSkillMd(
    raw: string,
    folderName: string,
    dirPath: string,
    source: IClawhubSkillEntry['source'],
  ): IClawhubSkillEntry {
    const { frontmatter, body } = this.extractFrontmatter(raw);

    return {
      name: frontmatter.name || folderName,
      description: frontmatter.description || '',
      dirPath,
      rawContent: raw,
      frontmatter,
      instructions: body,
      source,
    };
  }

  private extractFrontmatter(content: string): {
    frontmatter: IClawhubSkillFrontmatter;
    body: string;
  } {
    const fmRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
    const match = content.match(fmRegex);

    if (!match) {
      return { frontmatter: { name: '' }, body: content };
    }

    const fmRaw = match[1];
    const body = match[2];

    // Simple YAML-like parse for key: value (handles nested metadata as JSON)
    const fm: any = {};
    const lines = fmRaw.split('\n');
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      let value: any = line.slice(colonIdx + 1).trim();

      // Try JSON parse for metadata field
      if (key === 'metadata' && value.startsWith('{')) {
        try {
          // Collect remaining lines that might be part of JSON
          const jsonStart = lines.indexOf(line);
          const jsonLines = [value];
          for (let i = jsonStart + 1; i < lines.length; i++) {
            jsonLines.push(lines[i]);
            try {
              value = JSON.parse(jsonLines.join('\n'));
              break;
            } catch {
              continue;
            }
          }
          if (typeof value === 'string') value = JSON.parse(value);
        } catch {
          // Leave as string
        }
      } else if (value === 'true') {
        value = true;
      } else if (value === 'false') {
        value = false;
      }

      fm[key] = value;
    }

    return { frontmatter: fm as IClawhubSkillFrontmatter, body };
  }

  // ─── Query ──────────────────────────────────────────────────────────

  getSkill(name: string): IClawhubSkillEntry | undefined {
    return this.skills.get(name);
  }

  listSkills(): IClawhubSkillEntry[] {
    return Array.from(this.skills.values());
  }

  listBySource(source: IClawhubSkillEntry['source']): IClawhubSkillEntry[] {
    return this.listSkills().filter((s) => s.source === source);
  }

  /**
   * Format tất cả skills thành block XML để inject vào system prompt.
   * Kế thừa pattern formatSkillsForPrompt từ OpenClaw.
   */
  formatForPrompt(skillNames?: string[]): string {
    let skills = this.listSkills().filter(
      (s) => !s.frontmatter['disable-model-invocation'],
    );

    if (skillNames?.length) {
      skills = skills.filter((s) => skillNames.includes(s.name));
    }

    if (skills.length === 0) return '';

    const blocks = skills.map(
      (s) =>
        `<skill name="${s.name}">\n` +
        `<description>${s.description}</description>\n` +
        `<instructions>\n${s.instructions}\n</instructions>\n` +
        `</skill>`,
    );

    return (
      `<available_skills>\n` +
      `The following skills provide specialized capabilities. ` +
      `To use a skill, read its instructions and follow them.\n\n` +
      blocks.join('\n\n') +
      `\n</available_skills>`
    );
  }

  // ─── Install (via clawhub CLI) ──────────────────────────────────────

  /**
   * Cài skill từ ClawhHub registry bằng cách gọi clawhub CLI.
   * Yêu cầu: npm i -g clawhub
   */
  async installFromClawhub(skillName: string): Promise<IClawhubInstallResult> {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const managedDir = this.skillDirs.find((d) => d.source === 'managed')?.dir;
    if (!managedDir) {
      return { success: false, error: 'Managed skills directory not configured' };
    }

    // Ensure dir exists
    fs.mkdirSync(managedDir, { recursive: true });

    try {
      await execFileAsync('npx', ['clawhub', 'install', skillName], {
        cwd: managedDir,
        timeout: 60000,
      });

      // Reload to pick up new skill
      await this.loadAllSkills();

      const skill = this.getSkill(skillName);
      if (skill) {
        return { success: true, skill };
      }

      return { success: false, error: `Skill "${skillName}" installed but not found after reload` };
    } catch (error: any) {
      return {
        success: false,
        error: `clawhub install failed: ${error.stderr || error.message}`,
      };
    }
  }

  /**
   * Tìm skill trên ClawhHub registry.
   */
  async searchClawhub(query: string): Promise<any[]> {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    try {
      const { stdout } = await execFileAsync(
        'npx',
        ['clawhub', 'search', query, '--json'],
        { timeout: 30000 },
      );
      return JSON.parse(stdout);
    } catch {
      return [];
    }
  }
}
