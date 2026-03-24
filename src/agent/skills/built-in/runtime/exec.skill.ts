import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { RegisterSkill } from '../../decorators/skill.decorator';
import {
  ISkillRunner,
  ISkillDefinition,
  ISkillExecutionContext,
  ISkillResult,
  SkillCategory,
  SkillType,
} from '../../interfaces/skill-runner.interface';
import { ModelTier } from '../../../pipeline/model-router/model-tier.enum';
import { UsersService } from '../../../../modules/users/users.service';
import { WorkspaceService } from '../../../../gateway/workspace/workspace.service';

const execFileAsync = promisify(execFile);

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'Shell command to execute' },
    workdir: { type: 'string', description: 'Working directory' },
    timeout: {
      type: 'number',
      description: 'Timeout in milliseconds',
      default: 30000,
    },
    env: {
      type: 'object',
      description: 'Additional environment variables',
      additionalProperties: { type: 'string' },
    },
  },
  required: ['command'],
};

@RegisterSkill({
  code: 'exec',
  name: 'Execute Command',
  description:
    'Run a shell command and return its output. ' +
    'Use for file operations, system checks, running scripts, installing packages, ' +
    'git operations, and any task requiring command-line access. ' +
    'Commands run in a sandboxed environment with timeout protection.',
  category: SkillCategory.RUNTIME,
  parametersSchema: PARAMETERS_SCHEMA,
  ownerOnly: true,
  minModelTier: ModelTier.SKILL,
})
@Injectable()
export class ExecSkill implements ISkillRunner {
  private readonly logger = new Logger(ExecSkill.name);
  private readonly ownerExecHits = new Map<number, number[]>();

  constructor(
    private readonly usersService: UsersService,
    private readonly workspaceService: WorkspaceService,
  ) {}

  get definition(): ISkillDefinition {
    return {
      code: 'exec',
      name: 'Execute Command',
      description: 'Run a shell command and return its output',
      category: SkillCategory.RUNTIME,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
      ownerOnly: true,
      minModelTier: ModelTier.SKILL,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const {
      command,
      workdir,
      timeout = 30000,
      env: extraEnv,
    } = context.parameters;
    const commandText = String(command ?? '').trim();
    const cwd = String(workdir ?? process.cwd());

    if (this.isExecGuardEnabled()) {
      const rateErr = this.applyOwnerRateLimit(context.userId);
      if (rateErr) {
        this.auditExec(context.userId, commandText, cwd, false, rateErr);
        return {
          success: false,
          error: rateErr,
          metadata: { durationMs: Date.now() - start },
        };
      }
    }

    const policyError = this.isExecGuardEnabled()
      ? await this.validateExecSandbox(context, commandText, cwd)
      : null;
    if (policyError) {
      this.auditExec(context.userId, commandText, cwd, false, policyError);
      return {
        success: false,
        error: policyError,
        metadata: { durationMs: Date.now() - start },
      };
    }
    this.auditExec(context.userId, commandText, cwd, true);

    try {
      const { stdout, stderr } = await execFileAsync(
        '/bin/bash',
        ['-c', commandText],
        {
          cwd,
          timeout: timeout as number,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, ...(extraEnv as Record<string, string>) },
        },
      );

      return {
        success: true,
        data: {
          stdout: stdout.slice(0, 50000),
          stderr: stderr.slice(0, 10000),
          exitCode: 0,
        },
        metadata: { durationMs: Date.now() - start },
      };
    } catch (error: any) {
      return {
        success: error.code === 0,
        data: {
          stdout: error.stdout?.slice(0, 50000) || '',
          stderr: error.stderr?.slice(0, 10000) || error.message,
          exitCode: error.code ?? 1,
        },
        error: error.killed ? 'Command timed out' : undefined,
        metadata: { durationMs: Date.now() - start },
      };
    }
  }

  private async validateExecSandbox(
    context: ISkillExecutionContext,
    commandText: string,
    cwd: string,
  ): Promise<string | null> {
    const strictSandbox =
      String(process.env.EXEC_STRICT_SANDBOX ?? 'true').toLowerCase() !== 'false';
    if (!strictSandbox) return null;

    const allowedBinaries = this.parseAllowedBinaries(
      process.env.EXEC_ALLOWED_BINARIES,
    );
    const binary = this.extractBinary(commandText);
    if (!binary) {
      return 'Exec policy violation: command rỗng hoặc không parse được binary.';
    }
    if (!allowedBinaries.has(binary)) {
      return (
        `Exec policy violation: binary "${binary}" không nằm trong allowlist. ` +
        `Allowed: ${[...allowedBinaries].join(', ')}`
      );
    }

    // Chặn shell chaining/subshell/redirection để giảm bypass.
    if (/[;&|`<>]/.test(commandText) || /\$\(|\n|\r/.test(commandText)) {
      return (
        'Exec policy violation: không cho phép shell operators (; && || | ` < > $( ) newline).'
      );
    }

    // Chặn các cách đổi repo mục tiêu trong command để tránh thoát sandbox workdir.
    if (
      /(^|[\s])cd\s+/i.test(commandText) ||
      /\bgit\s+-C\s+/i.test(commandText) ||
      /\bGIT_DIR\s*=/i.test(commandText) ||
      /\bGIT_WORK_TREE\s*=/i.test(commandText) ||
      /\b--git-dir\b/i.test(commandText) ||
      /\b--work-tree\b/i.test(commandText)
    ) {
      return (
        'Exec policy violation: không dùng cd/git -C/GIT_DIR/GIT_WORK_TREE/--git-dir/--work-tree.'
      );
    }

    if (!path.isAbsolute(cwd)) {
      return 'Exec policy violation: workdir phải là absolute path.';
    }

    const user = await this.usersService.findById(context.userId);
    if (!user) {
      return 'Exec policy violation: user không tồn tại.';
    }

    const sharedSkillsDir = path.resolve(this.workspaceService.getSharedSkillsDir());
    const userSkillsDir = path.resolve(
      this.workspaceService.getUserSkillsDir(user.identifier),
    );
    const resolvedCwd = path.resolve(cwd);

    const isUnder = (root: string, target: string): boolean =>
      target === root || target.startsWith(root + path.sep);

    if (!isUnder(sharedSkillsDir, resolvedCwd) && !isUnder(userSkillsDir, resolvedCwd)) {
      return (
        'Exec policy violation: chỉ được chạy command trong thư mục skills. ' +
        `Allowed: ${sharedSkillsDir} hoặc ${userSkillsDir}`
      );
    }

    // Chặn path tuyệt đối hoặc path traversal trong args command.
    if (/(^|[\s"'`])\.\.(\/|\\)/.test(commandText)) {
      return 'Exec policy violation: không cho phép path traversal (../).';
    }
    if (/(^|[\s"'`])\/(?!\/)/.test(commandText)) {
      return 'Exec policy violation: không cho phép absolute path trong command args.';
    }

    return null;
  }

  private isExecGuardEnabled(): boolean {
    return String(process.env.EXEC_GUARD_ENABLED ?? 'false').toLowerCase() === 'true';
  }

  private applyOwnerRateLimit(userId: number): string | null {
    const enabled =
      String(process.env.EXEC_OWNER_RATE_LIMIT_ENABLED ?? 'true').toLowerCase() ===
      'true';
    if (!enabled) return null;

    const max = this.readIntEnv('EXEC_OWNER_RATE_LIMIT_MAX', 20, 1, 500);
    const windowMs = this.readIntEnv(
      'EXEC_OWNER_RATE_LIMIT_WINDOW_MS',
      60_000,
      5_000,
      3_600_000,
    );
    const now = Date.now();
    const hits = (this.ownerExecHits.get(userId) ?? []).filter(
      (ts) => now - ts <= windowMs,
    );
    if (hits.length >= max) {
      this.ownerExecHits.set(userId, hits);
      return `Exec rate limit exceeded: tối đa ${max} lệnh trong ${Math.floor(windowMs / 1000)}s.`;
    }
    hits.push(now);
    this.ownerExecHits.set(userId, hits);
    return null;
  }

  private auditExec(
    userId: number,
    commandText: string,
    cwd: string,
    allowed: boolean,
    reason?: string,
  ): void {
    const enabled =
      String(process.env.EXEC_AUDIT_LOG_ENABLED ?? 'true').toLowerCase() === 'true';
    if (!enabled) return;
    const compact = commandText.replace(/\s+/g, ' ').slice(0, 220);
    const msg =
      `[exec-audit] userId=${userId} allowed=${allowed} cwd="${cwd}" ` +
      `cmd="${compact}"` +
      (reason ? ` reason="${reason}"` : '');
    if (allowed) this.logger.log(msg);
    else this.logger.warn(msg);
  }

  private parseAllowedBinaries(raw?: string): Set<string> {
    const fallback = 'git';
    const value = (raw ?? fallback).trim() || fallback;
    return new Set(
      value
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter((x) => /^[a-z0-9._-]+$/.test(x)),
    );
  }

  private extractBinary(commandText: string): string | null {
    const m = commandText.trim().match(/^([a-zA-Z0-9._-]+)/);
    if (!m) return null;
    return m[1].toLowerCase();
  }

  private readIntEnv(
    key: string,
    defaultVal: number,
    min: number,
    max: number,
  ): number {
    const raw = process.env[key];
    const n = raw ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return defaultVal;
    return Math.min(max, Math.max(min, Math.floor(n)));
  }
}
