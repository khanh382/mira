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
import { WorkspaceService } from '../../../../gateway/workspace/workspace.service';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['append_memory', 'write_memory', 'append_daily', 'write_file', 'append_file'],
      description:
        'Action to perform:\n' +
        '- append_memory: Append content to MEMORY.md (long-term memory)\n' +
        '- write_memory: Overwrite MEMORY.md entirely\n' +
        '- append_daily: Append a note to today\'s daily memory file\n' +
        '- write_file: Write/overwrite a workspace file (e.g. notes/project.md)\n' +
        '- append_file: Append content to a workspace file',
    },
    content: {
      type: 'string',
      description: 'The content to write or append',
    },
    filename: {
      type: 'string',
      description:
        'Target filename within workspace (only for write_file/append_file). ' +
        'E.g. "notes/sheets.md", "context/google-sheets.md". ' +
        'Cannot use absolute paths or traverse outside workspace.',
    },
  },
  required: ['action', 'content'],
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
    'Prefer append_daily for transient notes (today\'s activities). ' +
    'Use append_memory for long-term facts (user preferences, important IDs). ' +
    'Use write_file for structured data (e.g. a dedicated file for Google Sheet tracking).',
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
    return {
      code: 'memory_write',
      name: 'Memory Write',
      description: 'Write or append to agent memory and workspace files',
      category: SkillCategory.MEMORY,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const { action, content, filename } = context.parameters as {
      action: string;
      content: string;
      filename?: string;
    };

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
        case 'append_memory':
          return this.appendMemory(identifier, content, start);

        case 'write_memory':
          return this.writeMemory(identifier, content, start);

        case 'append_daily':
          return this.appendDaily(identifier, content, start);

        case 'write_file':
          return this.writeFile(identifier, filename, content, start);

        case 'append_file':
          return this.appendFile(identifier, filename, content, start);

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
    const existing = this.workspaceService.readWorkspaceFile(identifier, 'MEMORY.md') || '';
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

  private writeFile(
    identifier: string,
    filename: string | undefined,
    content: string,
    start: number,
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

    this.workspaceService.writeWorkspaceFile(identifier, filename, content);
    return {
      success: true,
      data: { action: 'write_file', file: filename, bytesWritten: content.length },
      metadata: { durationMs: Date.now() - start },
    };
  }

  private appendFile(
    identifier: string,
    filename: string | undefined,
    content: string,
    start: number,
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

    const existing = this.workspaceService.readWorkspaceFile(identifier, filename) || '';
    this.workspaceService.writeWorkspaceFile(
      identifier,
      filename,
      existing + '\n' + content,
    );
    return {
      success: true,
      data: { action: 'append_file', file: filename, bytesWritten: content.length },
      metadata: { durationMs: Date.now() - start },
    };
  }

  private isPathSafe(filename: string): boolean {
    if (filename.startsWith('/') || filename.startsWith('\\')) return false;
    if (filename.includes('..')) return false;
    if (filename.includes('\0')) return false;
    return true;
  }
}
