import { Injectable, Logger } from '@nestjs/common';
import { RegisterSkill } from '../../decorators/skill.decorator';
import { GogCliService } from './gog-cli.service';
import { DriveTrackerService } from './drive-tracker.service';
import {
  ISkillRunner,
  ISkillDefinition,
  ISkillExecutionContext,
  ISkillResult,
  SkillCategory,
  SkillType,
} from '../../interfaces/skill-runner.interface';
import { ModelTier } from '../../../pipeline/model-router/model-tier.enum';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    service: {
      type: 'string',
      enum: [
        'gmail', 'calendar', 'drive', 'sheets', 'docs', 'slides',
        'contacts', 'tasks', 'forms', 'chat', 'keep', 'auth',
      ],
      description: 'Google Workspace service to interact with',
    },
    action: {
      type: 'string',
      description:
        'Action to perform. Examples: ' +
        'gmail: "search", "send", "labels list", "thread get <id>". ' +
        'calendar: "events --today", "create primary --summary ... --from ... --to ...", "freebusy". ' +
        'drive: "ls", "search <query>", "upload <path>", "download <id>". ' +
        'sheets: "get <id> A1:B10", "update <id> A1 val1|val2", "create <name>". ' +
        'docs: "cat <id>", "create <name>", "export <id> --format pdf". ' +
        'contacts: "list", "search <name>". ' +
        'tasks: "lists", "list <listId>", "add <listId> --title <title>", "done <listId> <taskId>".',
    },
    extraArgs: {
      type: 'string',
      description:
        'Additional CLI arguments as a single string. ' +
        'E.g. "--max 10 --from 2026-03-01 --to 2026-03-31"',
    },
    timeout: {
      type: 'number',
      description: 'Timeout in milliseconds (default: 30000)',
      default: 30000,
    },
  },
  required: ['service', 'action'],
};

@RegisterSkill({
  code: 'google_workspace',
  name: 'Google Workspace',
  description:
    'Interact with Google Workspace services (Gmail, Calendar, Drive, Sheets, Docs, ' +
    'Slides, Contacts, Tasks, Forms, Chat, Keep). ' +
    'Use to: search/send emails, manage calendar events, upload/download files from Drive, ' +
    'read/write spreadsheets, create documents, manage contacts and tasks. ' +
    'Each user has their own Google account configured independently.',
  category: SkillCategory.GOOGLE,
  parametersSchema: PARAMETERS_SCHEMA,
  minModelTier: ModelTier.SKILL,
})
@Injectable()
export class GoogleWorkspaceSkill implements ISkillRunner {
  private readonly logger = new Logger(GoogleWorkspaceSkill.name);

  constructor(
    private readonly gogCli: GogCliService,
    private readonly driveTracker: DriveTrackerService,
  ) {}

  get definition(): ISkillDefinition {
    return {
      code: 'google_workspace',
      name: 'Google Workspace',
      description:
        'Interact with Google Workspace services (Gmail, Calendar, Drive, Sheets, Docs, etc.)',
      category: SkillCategory.GOOGLE,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
      minModelTier: ModelTier.SKILL,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const {
      service,
      action,
      extraArgs,
      timeout = 30000,
    } = context.parameters;

    const available = await this.gogCli.isAvailable();
    if (!available) {
      return {
        success: false,
        error:
          'gogcli binary not installed. ' +
          'Install: brew install gogcli OR build from https://github.com/steipete/gogcli',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const account = await this.gogCli.getAccountForUser(context.userId);
    if (!account) {
      return {
        success: false,
        error:
          'Google account not configured for this user. ' +
          'Ask the admin to set bu_google_console_cloud_json_path in bot_users ' +
          'and run the initial auth setup.',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const args = this.buildArgs(service as string, action as string, extraArgs as string);

    const result = await this.gogCli.exec({
      userId: context.userId,
      args,
      timeout: timeout as number,
      json: true,
    });

    // Auto-track: ghi nhớ file/folder/sheet đã tạo, sửa, xóa vào GOOGLE_DRIVE.md
    this.driveTracker
      .trackOperation(
        context.userId,
        service as string,
        action as string,
        result.data,
        result.success,
      )
      .catch((err) =>
        this.logger.warn(`Drive tracking failed: ${err.message}`),
      );

    return {
      success: result.success,
      data: result.data,
      error: result.error,
      metadata: {
        durationMs: Date.now() - start,
        service: service as string,
        action: action as string,
        stderr: result.stderr,
      },
    };
  }

  /**
   * Parse service + action thành mảng args cho gog CLI.
   *
   * Ví dụ:
   *   service: "gmail", action: "search 'newer_than:7d'"
   *   → ["gmail", "search", "newer_than:7d"]
   *
   *   service: "calendar", action: "events primary --today"
   *   → ["calendar", "events", "primary", "--today"]
   *
   *   service: "sheets", action: "get <id> 'Sheet1!A1:B10'"
   *   → ["sheets", "get", "<id>", "Sheet1!A1:B10"]
   */
  private buildArgs(service: string, action: string, extraArgs?: string): string[] {
    const args: string[] = [service];

    const actionParts = this.parseShellArgs(action);
    args.push(...actionParts);

    if (extraArgs) {
      const extraParts = this.parseShellArgs(extraArgs);
      args.push(...extraParts);
    }

    return args;
  }

  /**
   * Tách chuỗi thành mảng args, tôn trọng dấu nháy đơn/kép.
   */
  private parseShellArgs(input: string): string[] {
    const args: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];

      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        continue;
      }
      if (ch === ' ' && !inSingle && !inDouble) {
        if (current) {
          args.push(current);
          current = '';
        }
        continue;
      }
      current += ch;
    }
    if (current) args.push(current);

    return args;
  }
}
