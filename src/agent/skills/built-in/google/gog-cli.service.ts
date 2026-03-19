import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { BotUsersService } from '../../../../modules/bot-users/bot-users.service';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const GOG_REPO = 'https://github.com/steipete/gogcli.git';
const GOG_LOCAL_DIR_NAME = '.gogcli';

interface GogExecOptions {
  userId: number;
  args: string[];
  timeout?: number;
  json?: boolean;
}

interface GogExecResult {
  success: boolean;
  data?: unknown;
  stdout?: string;
  stderr?: string;
  error?: string;
}

/**
 * GogCliService — wrapper xung quanh binary `gog` (gogcli).
 *
 * Mỗi user có credentials riêng (bu_google_console_cloud_json_path).
 * Mọi lệnh gog đều chạy với context user tương ứng.
 *
 * Auto-install:
 *   Khi backend start, nếu binary `gog` không tìm thấy:
 *   1. Thử `brew install gogcli` (nếu có brew)
 *   2. Fallback: git clone + make → build vào <project>/.gogcli/bin/gog
 *   3. Tự cập nhật gogBin path để dùng local build
 *
 * Auth flow:
 *   1. Admin lưu Google Console Cloud JSON path vào bot_users
 *   2. Khi user lần đầu dùng → service tự chạy `gog auth credentials` + `gog auth add`
 *   3. Các lần sau → gog tự dùng stored token (auto-refresh)
 */
@Injectable()
export class GogCliService implements OnModuleInit {
  private readonly logger = new Logger(GogCliService.name);
  private gogBin: string;
  private configDir: string;
  private ready = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly botUsersService: BotUsersService,
  ) {}

  async onModuleInit() {
    this.gogBin = this.configService.get('GOG_BIN', 'gog');
    this.configDir = this.configService.get(
      'GOG_CONFIG_DIR',
      `${process.env.HOME}/.config/gogcli`,
    );

    await this.ensureBinary();
  }

  private async ensureBinary(): Promise<void> {
    if (await this.testBinary(this.gogBin)) {
      this.ready = true;
      return;
    }

    const localBin = this.getLocalBinPath();
    if (await this.testBinary(localBin)) {
      this.gogBin = localBin;
      this.ready = true;
      return;
    }

    this.logger.log('gogcli not found — attempting auto-install...');

    if (await this.installViaBrew()) {
      this.ready = true;
      return;
    }

    if (await this.installFromSource()) {
      this.gogBin = localBin;
      this.ready = true;
      return;
    }

    this.logger.warn(
      'gogcli auto-install failed. Google Workspace skills unavailable. ' +
      'Manual install: brew install gogcli OR build from ' + GOG_REPO,
    );
  }

  private getLocalBinPath(): string {
    return join(process.cwd(), GOG_LOCAL_DIR_NAME, 'bin', 'gog');
  }

  private async testBinary(bin: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(bin, ['--version'], {
        timeout: 5000,
      });
      this.logger.log(`gogcli ready: ${stdout.trim()} (${bin})`);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Install strategies ───────────────────────────────────────────

  private async installViaBrew(): Promise<boolean> {
    try {
      await execAsync('which brew', { timeout: 3000 });
    } catch {
      this.logger.debug('brew not found, skipping brew install');
      return false;
    }

    try {
      this.logger.log('Installing gogcli via brew...');
      await execAsync('brew install gogcli', { timeout: 120000 });

      if (await this.testBinary('gog')) {
        this.gogBin = 'gog';
        return true;
      }
    } catch (err: any) {
      this.logger.debug(`brew install failed: ${err.message}`);
    }

    return false;
  }

  private async installFromSource(): Promise<boolean> {
    for (const tool of ['git', 'go']) {
      try {
        await execAsync(`which ${tool}`, { timeout: 3000 });
      } catch {
        this.logger.debug(`${tool} not found, cannot build from source`);
        return false;
      }
    }

    const localDir = join(process.cwd(), GOG_LOCAL_DIR_NAME);
    const srcDir = join(localDir, 'src');
    const binDir = join(localDir, 'bin');

    try {
      mkdirSync(binDir, { recursive: true });

      if (!existsSync(join(srcDir, '.git'))) {
        this.logger.log(`Cloning gogcli from ${GOG_REPO}...`);
        await execAsync(
          `git clone --depth 1 ${GOG_REPO} "${srcDir}"`,
          { timeout: 60000 },
        );
      } else {
        this.logger.log('Updating gogcli source...');
        await execAsync('git pull --ff-only', {
          cwd: srcDir,
          timeout: 30000,
        });
      }

      this.logger.log('Building gogcli...');
      await execAsync('make', { cwd: srcDir, timeout: 120000 });

      const builtBin = join(srcDir, 'bin', 'gog');
      const targetBin = join(binDir, 'gog');

      if (existsSync(builtBin)) {
        await execAsync(`cp "${builtBin}" "${targetBin}"`);
        chmodSync(targetBin, 0o755);

        if (await this.testBinary(targetBin)) {
          return true;
        }
      }
    } catch (err: any) {
      this.logger.warn(`Build from source failed: ${err.message}`);
    }

    return false;
  }

  // ─── Public API ───────────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    return this.ready;
  }

  async getAccountForUser(userId: number): Promise<string | null> {
    const botUser = await this.botUsersService.findByUserId(userId);
    if (!botUser?.googleConsoleCloudJsonPath) return null;

    if (!existsSync(botUser.googleConsoleCloudJsonPath)) {
      this.logger.warn(
        `Google credentials file not found: ${botUser.googleConsoleCloudJsonPath} (user ${userId})`,
      );
      return null;
    }

    return this.configService.get(`GOG_ACCOUNT_USER_${userId}`, null);
  }

  async setupCredentials(
    userId: number,
    email: string,
  ): Promise<GogExecResult> {
    const botUser = await this.botUsersService.findByUserId(userId);
    if (!botUser?.googleConsoleCloudJsonPath) {
      return {
        success: false,
        error: 'Google Console Cloud JSON path not configured for this user',
      };
    }

    const credResult = await this.rawExec([
      'auth', 'credentials', botUser.googleConsoleCloudJsonPath,
      '--client', `user_${userId}`,
    ]);

    if (!credResult.success) return credResult;

    const addResult = await this.rawExec([
      '--client', `user_${userId}`,
      'auth', 'add', email,
      '--services', 'user',
      '--manual',
    ]);

    return addResult;
  }

  async exec(options: GogExecOptions): Promise<GogExecResult> {
    const { userId, args, timeout = 30000, json = true } = options;

    if (!this.ready) {
      return { success: false, error: 'gogcli binary not available' };
    }

    const account = await this.getAccountForUser(userId);

    const fullArgs: string[] = ['--client', `user_${userId}`];

    if (account) {
      fullArgs.push('--account', account);
    }

    if (json) {
      fullArgs.push('--json');
    }

    fullArgs.push(...args);

    return this.rawExec(fullArgs, timeout);
  }

  private async rawExec(
    args: string[],
    timeout = 30000,
  ): Promise<GogExecResult> {
    try {
      this.logger.debug(`gog ${args.join(' ')}`);

      const { stdout, stderr } = await execFileAsync(this.gogBin, args, {
        timeout,
        maxBuffer: 5 * 1024 * 1024,
        env: {
          ...process.env,
          GOG_KEYRING_BACKEND: 'file',
          GOG_KEYRING_PASSWORD: this.configService.get(
            'GOG_KEYRING_PASSWORD',
            'mira_default_keyring',
          ),
          NO_COLOR: '1',
        },
      });

      let data: unknown = stdout;
      try {
        data = JSON.parse(stdout);
      } catch {
        // not JSON, keep as string
      }

      return {
        success: true,
        data,
        stdout: typeof data === 'string' ? stdout.slice(0, 50000) : undefined,
        stderr: stderr ? stderr.slice(0, 5000) : undefined,
      };
    } catch (error: any) {
      return {
        success: false,
        stdout: error.stdout?.slice(0, 50000),
        stderr: error.stderr?.slice(0, 5000),
        error: error.killed
          ? `Command timed out after ${timeout}ms`
          : error.message,
      };
    }
  }
}
