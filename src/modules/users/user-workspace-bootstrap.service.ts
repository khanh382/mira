import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_BRAIN_DIR } from '../../config/brain-dir.config';

@Injectable()
export class UserWorkspaceBootstrapService {
  constructor(private readonly configService: ConfigService) {}

  private resolveBrainDir(): string {
    const raw = this.configService.get<string>('BRAIN_DIR', DEFAULT_BRAIN_DIR);
    return path.resolve(raw);
  }

  private ensureDir(p: string): void {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
    }
  }

  private ensureFileIfMissing(p: string, content: string): void {
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, content);
    }
  }

  /**
   * Ensure default per-user workspace structure and files exist.
   * Missing pieces are created without overriding existing content.
   */
  ensureDefaultWorkspace(identifier: string): void {
    const brainDir = this.resolveBrainDir();
    const userDir = path.join(brainDir, identifier);
    const workspaceDir = path.join(userDir, 'workspace');
    const sessionsDir = path.join(userDir, 'sessions');
    const skillsDir = path.join(userDir, 'skills');
    const memoryDir = path.join(userDir, 'memory');
    const cookiesDir = path.join(userDir, 'cookies');
    const sharedDir = path.join(brainDir, '_shared');

    this.ensureDir(workspaceDir);
    this.ensureDir(sessionsDir);
    this.ensureDir(skillsDir);
    this.ensureDir(memoryDir);
    this.ensureDir(cookiesDir);

    // Copy shared templates if available.
    const sharedTemplates = ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'HEARTBEAT.md'];
    for (const file of sharedTemplates) {
      const src = path.join(sharedDir, file);
      const dst = path.join(workspaceDir, file);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
      }
    }

    this.ensureFileIfMissing(
      path.join(workspaceDir, 'IDENTITY.md'),
      `# IDENTITY.md\n\nAgent of user: ${identifier}\nCreated at: ${new Date().toISOString()}\n`,
    );
    this.ensureFileIfMissing(
      path.join(workspaceDir, 'USER.md'),
      '# USER.md\n\n- Name: \n- Timezone: Asia/Ho_Chi_Minh\n- Notes: \n',
    );
    this.ensureFileIfMissing(path.join(workspaceDir, 'MEMORY.md'), '# MEMORY.md\n\n');
    this.ensureFileIfMissing(
      path.join(workspaceDir, 'USER_CONTEXT.md'),
      '# USER_CONTEXT.md\n\n',
    );
  }
}
