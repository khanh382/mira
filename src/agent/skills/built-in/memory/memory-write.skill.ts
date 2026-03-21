import { Injectable, Logger } from '@nestjs/common';
import { RegisterSkill } from '../../decorators/skill.decorator';
import {
  ISkillRunner,
  ISkillDefinition,
  ISkillExecutionContext,
  ISkillResult,
  SkillCategory,
  SkillType,
} from '../../interfaces/skill-runner.interface';
import { UsersService } from '../../../../modules/users/users.service';
import {
  User,
  UserLevel,
} from '../../../../modules/users/entities/user.entity';
import { WorkspaceService } from '../../../../gateway/workspace/workspace.service';
import { createHash } from 'crypto';
import {
  OWNER_SHARED_MARKDOWN_FILES,
  isOwnerSharedMarkdownFilename,
  type OwnerSharedMarkdownFile,
} from '../../../../config/owner-shared-markdown.config';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'append_memory',
        'write_memory',
        'append_daily',
        'write_file',
        'append_file',
        'read_shared_file',
        'read_shared_processes',
      ],
      description:
        'Action to perform:\n' +
        '- append_memory: Append content to MEMORY.md (long-term memory)\n' +
        '- write_memory: Overwrite MEMORY.md entirely\n' +
        "- append_daily: Append a note to today's daily memory file\n" +
        '- read_shared_file: (owner) Read full `$BRAIN_DIR/_shared/<sharedFilename>.md` from disk + contentSha256 — **call this before** updating that file\n' +
        '- read_shared_processes: (owner) Alias for read_shared_file with PROCESSES.md\n' +
        '- write_file: Write/overwrite a workspace file (e.g. notes/project.md)\n' +
        '- append_file: Append content to a workspace file\n' +
        '- Root filenames ' +
        OWNER_SHARED_MARKDOWN_FILES.join(', ') +
        ' → `$BRAIN_DIR/_shared/` (owner only). Requires ifMatchSha256 from read_shared_file for that file.',
    },
    content: {
      type: 'string',
      description:
        'The content to write or append (omit or empty for read_shared_file / read_shared_processes).',
    },
    filename: {
      type: 'string',
      description:
        'Target filename within workspace (only for write_file/append_file). ' +
        'E.g. "notes/sheets.md", "context/google-sheets.md". ' +
        'Root-only ' +
        OWNER_SHARED_MARKDOWN_FILES.join(', ') +
        ' → `$BRAIN_DIR/_shared/` (owner only; requires ifMatchSha256 from read_shared_file). ' +
        'Cannot use absolute paths or traverse outside workspace.',
    },
    sharedFilename: {
      type: 'string',
      enum: [...OWNER_SHARED_MARKDOWN_FILES],
      description:
        'Required for read_shared_file: which `_shared/*.md` to read from disk (full content + contentSha256).',
    },
    ifMatchSha256: {
      type: 'string',
      description:
        '**Required** for write_file/append_file when filename is one of ' +
        OWNER_SHARED_MARKDOWN_FILES.join(', ') +
        ' at workspace root. Must equal `contentSha256` from the latest read_shared_file for that file (optimistic lock).',
    },
  },
  required: ['action'],
};

@RegisterSkill({
  code: 'memory_write',
  name: 'Memory Write',
  description:
    'Write or append to agent memory files. Use this to save important information ' +
    'that should be remembered across conversations:\n' +
    '- Spreadsheet IDs, document links, file references\n' +
    '- User preferences and settings discovered during conversation\n' +
    '- Task results, summaries, and notes\n' +
    '- Any context the agent needs to recall later\n\n' +
    "Prefer append_daily for transient notes (today's activities). " +
    'Use append_memory for long-term facts (user preferences, important IDs). ' +
    'Use write_file for structured data (e.g. a dedicated file for Google Sheet tracking). ' +
    'Updating `$BRAIN_DIR/_shared/` markdown (PROCESSES, AGENTS, HEARTBEAT, TOOLS, SOUL): owner must call read_shared_file first ' +
    '(full file from disk + contentSha256), merge with user request in reasoning, then write_file/append_file with matching root filename and ifMatchSha256.',
  category: SkillCategory.MEMORY,
  parametersSchema: PARAMETERS_SCHEMA,
})
@Injectable()
export class MemoryWriteSkill implements ISkillRunner {
  private readonly logger = new Logger(MemoryWriteSkill.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly workspaceService: WorkspaceService,
  ) {}

  get definition(): ISkillDefinition {
    const procPath = this.sharedMarkdownPathDisplay('PROCESSES.md');
    return {
      code: 'memory_write',
      name: 'Memory Write',
      description:
        `Write or append to agent memory and workspace files. Example shared file on disk: ${procPath} (BRAIN_DIR). Owner-shared: ${OWNER_SHARED_MARKDOWN_FILES.join(', ')}.`,
      category: SkillCategory.MEMORY,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
    };
  }

  /** Đường dẫn thật tới `_shared/<name>` dùng trong tool result / lỗi. */
  private sharedMarkdownPathDisplay(name: OwnerSharedMarkdownFile): string {
    return this.workspaceService.getSharedMarkdownPath(name).replace(/\\/g, '/');
  }

  /**
   * Chỉ tên file ở root (không subpath) và thuộc whitelist → `$BRAIN_DIR/_shared/`.
   */
  private sharedMarkdownBasenameIfRoot(
    filename: string | undefined,
  ): OwnerSharedMarkdownFile | null {
    if (!filename) return null;
    const f = filename.trim();
    if (f.includes('/') || f.includes('\\')) return null;
    if (!isOwnerSharedMarkdownFilename(f)) return null;
    return f as OwnerSharedMarkdownFile;
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const params = context.parameters as {
      action?: string;
      content?: string;
      filename?: string;
      sharedFilename?: string;
      ifMatchSha256?: string;
    };
    const action = String(params.action ?? '').trim();
    const content = params.content ?? '';
    const filename = params.filename;
    const ifMatchSha256 =
      typeof params.ifMatchSha256 === 'string'
        ? params.ifMatchSha256.trim()
        : undefined;

    const user = await this.usersService.findById(context.userId);
    if (!user) {
      return {
        success: false,
        error: 'User not found',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const identifier = user.identifier;

    try {
      switch (action) {
        case 'read_shared_file':
          return this.readSharedMarkdownFile(user, params.sharedFilename, start);

        case 'read_shared_processes':
          return this.readSharedMarkdownFile(
            user,
            'PROCESSES.md',
            start,
            'read_shared_processes',
          );

        case 'append_memory':
          return this.appendMemory(identifier, content, start);

        case 'write_memory':
          return this.writeMemory(identifier, content, start);

        case 'append_daily':
          return this.appendDaily(identifier, content, start);

        case 'write_file':
          return this.writeFile(
            user,
            identifier,
            filename,
            content,
            start,
            ifMatchSha256,
          );

        case 'append_file':
          return this.appendFile(
            user,
            identifier,
            filename,
            content,
            start,
            ifMatchSha256,
          );

        default:
          return {
            success: false,
            error: `Unknown action: ${action}`,
            metadata: { durationMs: Date.now() - start },
          };
      }
    } catch (error) {
      this.logger.error(`memory_write failed: ${error.message}`, error.stack);
      return {
        success: false,
        error: error.message,
        metadata: { durationMs: Date.now() - start },
      };
    }
  }

  private appendMemory(
    identifier: string,
    content: string,
    start: number,
  ): ISkillResult {
    const existing =
      this.workspaceService.readWorkspaceFile(identifier, 'MEMORY.md') || '';
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const entry = `\n\n<!-- ${timestamp} -->\n${content}`;
    this.workspaceService.writeWorkspaceFile(
      identifier,
      'MEMORY.md',
      existing + entry,
    );
    return {
      success: true,
      data: {
        action: 'append_memory',
        file: 'MEMORY.md',
        bytesWritten: entry.length,
      },
      metadata: { durationMs: Date.now() - start },
    };
  }

  private writeMemory(
    identifier: string,
    content: string,
    start: number,
  ): ISkillResult {
    this.workspaceService.writeWorkspaceFile(identifier, 'MEMORY.md', content);
    return {
      success: true,
      data: {
        action: 'write_memory',
        file: 'MEMORY.md',
        bytesWritten: content.length,
      },
      metadata: { durationMs: Date.now() - start },
    };
  }

  private appendDaily(
    identifier: string,
    content: string,
    start: number,
  ): ISkillResult {
    const timestamp = new Date().toLocaleTimeString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
    });
    const entry = `- [${timestamp}] ${content}`;
    this.workspaceService.appendDailyMemory(identifier, entry);
    return {
      success: true,
      data: {
        action: 'append_daily',
        entry,
      },
      metadata: { durationMs: Date.now() - start },
    };
  }

  private readSharedMarkdownFile(
    user: User,
    sharedFilename: string | undefined,
    start: number,
    respondAsAction: 'read_shared_file' | 'read_shared_processes' = 'read_shared_file',
  ): ISkillResult {
    const name = String(sharedFilename ?? '').trim();
    if (!isOwnerSharedMarkdownFilename(name)) {
      return {
        success: false,
        error: `read_shared_file requires sharedFilename, one of: ${OWNER_SHARED_MARKDOWN_FILES.join(', ')}.`,
        metadata: { durationMs: Date.now() - start },
      };
    }
    const file = name as OwnerSharedMarkdownFile;
    const pathDisplay = this.sharedMarkdownPathDisplay(file);
    if (user.level !== UserLevel.OWNER) {
      return {
        success: false,
        error: `Only owner can read ${pathDisplay} via read_shared_file.`,
        metadata: { durationMs: Date.now() - start },
      };
    }
    const fullContent = this.workspaceService.readSharedMarkdown(file);
    const contentSha256 = sha256Utf8(fullContent);
    return {
      success: true,
      data: {
        action: respondAsAction,
        sharedFilename: file,
        path: pathDisplay,
        fullContent,
        contentSha256,
        hint:
          `Use fullContent + user request to reason, then write_file with filename ${file}, content=<full new file>, ifMatchSha256=contentSha256 above.`,
      },
      metadata: { durationMs: Date.now() - start },
    };
  }

  private writeFile(
    user: User,
    identifier: string,
    filename: string | undefined,
    content: string,
    start: number,
    ifMatchSha256?: string,
  ): ISkillResult {
    if (!filename) {
      return {
        success: false,
        error: 'filename is required for write_file action',
        metadata: { durationMs: Date.now() - start },
      };
    }

    if (!this.isPathSafe(filename)) {
      return {
        success: false,
        error: 'Invalid filename: must be relative, no ".." traversal',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const sharedName = this.sharedMarkdownBasenameIfRoot(filename);
    if (sharedName) {
      if (user.level !== UserLevel.OWNER) {
        return {
          success: false,
          error: `Only owner can update ${this.sharedMarkdownPathDisplay(sharedName)} (memory_write root filename "${sharedName}").`,
          metadata: { durationMs: Date.now() - start },
        };
      }
      const lock = this.verifySharedMarkdownIfMatch(sharedName, ifMatchSha256);
      if (lock.ok === false) {
        return {
          success: false,
          error: lock.error,
          metadata: { durationMs: Date.now() - start },
        };
      }
      this.workspaceService.writeSharedMarkdown(sharedName, content);
      return {
        success: true,
        data: {
          action: 'write_file',
          file: this.sharedMarkdownPathDisplay(sharedName),
          bytesWritten: content.length,
          newContentSha256: sha256Utf8(content),
        },
        metadata: { durationMs: Date.now() - start },
      };
    }

    this.workspaceService.writeWorkspaceFile(identifier, filename, content);
    return {
      success: true,
      data: {
        action: 'write_file',
        file: filename,
        bytesWritten: content.length,
      },
      metadata: { durationMs: Date.now() - start },
    };
  }

  private appendFile(
    user: User,
    identifier: string,
    filename: string | undefined,
    content: string,
    start: number,
    ifMatchSha256?: string,
  ): ISkillResult {
    if (!filename) {
      return {
        success: false,
        error: 'filename is required for append_file action',
        metadata: { durationMs: Date.now() - start },
      };
    }

    if (!this.isPathSafe(filename)) {
      return {
        success: false,
        error: 'Invalid filename: must be relative, no ".." traversal',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const sharedNameAppend = this.sharedMarkdownBasenameIfRoot(filename);
    if (sharedNameAppend) {
      if (user.level !== UserLevel.OWNER) {
        return {
          success: false,
          error: `Only owner can append to ${this.sharedMarkdownPathDisplay(sharedNameAppend)} (memory_write root filename "${sharedNameAppend}").`,
          metadata: { durationMs: Date.now() - start },
        };
      }
      const lock = this.verifySharedMarkdownIfMatch(
        sharedNameAppend,
        ifMatchSha256,
      );
      if (lock.ok === false) {
        return {
          success: false,
          error: lock.error,
          metadata: { durationMs: Date.now() - start },
        };
      }
      this.workspaceService.appendSharedMarkdown(sharedNameAppend, content);
      const merged = this.workspaceService.readSharedMarkdown(sharedNameAppend);
      return {
        success: true,
        data: {
          action: 'append_file',
          file: this.sharedMarkdownPathDisplay(sharedNameAppend),
          bytesWritten: content.length,
          newContentSha256: sha256Utf8(merged),
        },
        metadata: { durationMs: Date.now() - start },
      };
    }

    const existing =
      this.workspaceService.readWorkspaceFile(identifier, filename) || '';
    this.workspaceService.writeWorkspaceFile(
      identifier,
      filename,
      existing + '\n' + content,
    );
    return {
      success: true,
      data: {
        action: 'append_file',
        file: filename,
        bytesWritten: content.length,
      },
      metadata: { durationMs: Date.now() - start },
    };
  }

  /**
   * Bắt buộc đọc trước (read_shared_file): hash nội dung hiện tại trên đĩa phải khớp ifMatchSha256.
   */
  private verifySharedMarkdownIfMatch(
    sharedFilename: OwnerSharedMarkdownFile,
    ifMatchSha256: string | undefined,
  ): { ok: true } | { ok: false; error: string } {
    const pathDisplay = this.sharedMarkdownPathDisplay(sharedFilename);
    if (!ifMatchSha256) {
      return {
        ok: false,
        error:
          `${pathDisplay}: bắt buộc gọi action read_shared_file với sharedFilename="${sharedFilename}" trước, lấy contentSha256 rồi truyền ifMatchSha256 cùng write_file/append_file.`,
      };
    }
    const current = this.workspaceService.readSharedMarkdown(sharedFilename);
    const currentSha = sha256Utf8(current);
    const want = ifMatchSha256.trim().toLowerCase();
    if (currentSha !== want) {
      return {
        ok: false,
        error:
          `${pathDisplay} đã đổi trên đĩa hoặc ifMatchSha256 không khớp. Gọi lại read_shared_file rồi phân tích và ghi với ifMatchSha256 mới.`,
      };
    }
    return { ok: true };
  }

  private isPathSafe(filename: string): boolean {
    if (filename.startsWith('/') || filename.startsWith('\\')) return false;
    if (filename.includes('..')) return false;
    if (filename.includes('\0')) return false;
    return true;
  }
}

function sha256Utf8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
