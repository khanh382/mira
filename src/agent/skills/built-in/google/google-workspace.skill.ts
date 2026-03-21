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
        'gmail',
        'calendar',
        'drive',
        'sheets',
        'docs',
        'slides',
        'contacts',
        'tasks',
        'forms',
        'chat',
        'keep',
        'auth',
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
        // gogcli supports much more than cat/create/export; include common write/update verbs
        // so the model doesn't hallucinate that "gog only supports Sheets".
        'docs: ' +
        '"cat <id>", ' +
        '"write <id> --text <content> [--append]", ' +
        '"insert <id> <content> --index <n>", ' +
        '"edit <id> <find> <replace>", ' +
        '"clear <id>", ' +
        '"export <id> --format pdf". ' +
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
    'Each user has their own Google account configured independently. ' +
    'For Drive deletion: `drive delete <id>` moves to Trash; add `--permanent` to delete forever.',
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
    const { service, action, extraArgs, timeout = 30000 } = context.parameters;

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

    // Build gog CLI args.
    //
    // Drive delete semantics (gogcli):
    // - `gog drive delete <id>`  => move to Trash
    // - `gog drive delete <id> --permanent` => delete forever
    //
    // Requirement: only delete forever when the request is explicit.
    // So: do NOT auto-add `--permanent` unless it already appears in tool args.
    const serviceStr = service as string;
    const actionStr = action as string;
    const extraArgsStr = extraArgs as string;

    let actionParts = this.parseShellArgs(actionStr);
    const extraParts = extraArgsStr ? this.parseShellArgs(extraArgsStr) : [];

    const hasPermanent =
      actionParts.includes('--permanent') || extraParts.includes('--permanent');

    const actionRaw = `${actionStr ?? ''} ${extraArgsStr ?? ''}`.toLowerCase();
    const isDriveEmptyTrash =
      serviceStr === 'drive' &&
      // Match emptytrash / empty-trash / empty_trash (and tolerate spaces).
      /empty[\s_-]?trash/.test(actionRaw);

    if (isDriveEmptyTrash) {
      if (!hasPermanent) {
        return {
          success: false,
          error:
            'drive empty-trash/emptytrash cần `--permanent` để xóa vĩnh viễn.',
          metadata: { durationMs: Date.now() - start, service: serviceStr, action: actionStr, appliedPermanent: hasPermanent },
        };
      }

      const extractIds = (data: any): string[] => {
        const arr =
          data?.files ??
          data?.items ??
          data?.results ??
          (Array.isArray(data) ? data : undefined);
        if (!Array.isArray(arr)) return [];
        return arr
          .map((x: any) => x?.id ?? x?.fileId ?? x?.resourceId)
          .filter((v: any) => typeof v === 'string' && v.length > 0);
      };

      // Gogcli's "emptytrash" is not fully deterministic across versions/aliases.
      // For correctness, we delete each trashed item permanently after searching.
      const QUERY = 'trashed = true';
      const MAX_PER_PASS = 200;
      const MAX_PASSES = 8;
      const DELAY_MS_BETWEEN_PASSES = 1200;
      const MAX_TOTAL_DELETES = 2000;

      let deletedCount = 0;
      let remaining = -1;
      const errors: Array<{ id?: string; error: any }> = [];
      let totalDeleteAttempts = 0;

      const extractItems = (data: any): Array<{ id: string; name?: string }> => {
        const arr =
          data?.files ??
          data?.items ??
          data?.results ??
          (Array.isArray(data) ? data : undefined);
        if (!Array.isArray(arr)) return [];
        return arr
          .map((x: any) => {
            const id = x?.id ?? x?.fileId ?? x?.resourceId;
            const name = x?.name ?? x?.title ?? x?.fileName;
            return typeof id === 'string' && id.length > 0 ? { id, name } : null;
          })
          .filter(Boolean) as Array<{ id: string; name?: string }>;
      };

      const delay = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));

      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const list = await this.gogCli.exec({
          userId: context.userId,
          args: [
            'drive',
            'search',
            QUERY,
            '--raw-query',
            '--max',
            String(MAX_PER_PASS),
          ],
          timeout: timeout as number,
          json: true,
        });

        if (!list.success) {
          return {
            success: false,
            error:
              'Không đọc được danh sách item trong thùng rác (Trash) để xóa vĩnh viễn.',
            metadata: {
              durationMs: Date.now() - start,
              service: serviceStr,
              action: actionStr,
              stderr: list.stderr,
              appliedPermanent: hasPermanent,
              list,
            },
          };
        }

        const items = extractItems(list.data);
        const ids = items.map((x) => x.id);
        remaining = ids.length;
        if (remaining === 0) break;

        for (const id of ids) {
          if (totalDeleteAttempts >= MAX_TOTAL_DELETES) {
            break;
          }
          const del = await this.gogCli.exec({
            userId: context.userId,
            // Some trashed items can require --force to be removed deterministically.
            args: ['drive', 'delete', id, '--permanent', '--force'],
            timeout: timeout as number,
            json: true,
          });

          totalDeleteAttempts++;
          if (del.success) {
            deletedCount++;
          } else {
            errors.push({ id, error: del });
          }
        }

        // Wait for eventual-consistency (Google Drive Trash updates may lag).
        await delay(DELAY_MS_BETWEEN_PASSES);

        const verifyPass = await this.gogCli.exec({
          userId: context.userId,
          args: ['drive', 'search', QUERY, '--raw-query', '--max', '1'],
          timeout: timeout as number,
          json: true,
        });
        remaining = verifyPass.success ? extractIds(verifyPass.data).length : -1;
        if (remaining === 0) break;
      }

      // Final verification: is there any trashed item left?
      const verify = await this.gogCli.exec({
        userId: context.userId,
        args: ['drive', 'search', QUERY, '--raw-query', '--max', '1'],
        timeout: timeout as number,
        json: true,
      });

      const verifyIds = verify.success ? extractIds(verify.data) : [];
      remaining = verifyIds.length;

      if (remaining === 0) {
        return {
          success: true,
          data: {
            deletedCount,
            remainingTrash: 0,
            totalDeleteAttempts,
          },
          metadata: {
            durationMs: Date.now() - start,
            service: serviceStr,
            action: actionStr,
            appliedPermanent: hasPermanent,
            deletedCount,
            totalDeleteAttempts,
          },
        };
      }

      const verifyList = await this.gogCli.exec({
        userId: context.userId,
        args: ['drive', 'search', QUERY, '--raw-query', '--max', '10'],
        timeout: timeout as number,
        json: true,
      });
      const remainingItemsPreview = verifyList.success
        ? extractItems(verifyList.data).slice(0, 5)
        : [];
      const previewIds = remainingItemsPreview.map((x) => x.id).join(', ');

      return {
        success: false,
        error:
          `Xóa vĩnh viễn thùng rác chưa hoàn tất: vẫn còn ${remaining} item trong Trash. Ví dụ còn: ${previewIds || 'unknown'}.`,
        data: {
          deletedCount,
          remainingTrash: remaining,
          errorsCount: errors.length,
          totalDeleteAttempts,
          remainingItemsPreview,
        },
        metadata: {
          durationMs: Date.now() - start,
          service: serviceStr,
          action: actionStr,
          appliedPermanent: hasPermanent,
          errorsCount: errors.length,
          totalDeleteAttempts,
        },
      };
    }

    // First non-flag token after op is likely the fileId.
    const idLooksLikeDriveId = (v: string): boolean =>
      /^[A-Za-z0-9_-]{10,}$/.test(v);

    let driveDeleteFileId: string | null = null;
    let appliedPermanent = hasPermanent;

    if (serviceStr === 'drive' && actionParts.length > 0) {
      const op = actionParts[0];
      const looksDelete = op === 'delete' || op === 'rm';
      if (looksDelete) {
        if (op === 'rm') {
          actionParts[0] = 'delete';
        }

        // Extract fileId robustly (id might not be exactly at index 1).
        const maybeId = actionParts.slice(1).find((p) => !p.startsWith('-') && idLooksLikeDriveId(p));
        driveDeleteFileId = maybeId ? String(maybeId) : null;
      }
    }

    // Fix common gogcli sheets.update value formatting:
    // - gog expects: comma-separated rows, pipe-separated cells
    // - LLM often sends: pipe-separated rows, comma-separated cells (wrong)
    // Examples:
    //   WRONG: 1,Kiểm tra email,20|2,Họp team,50
    //   RIGHT: 1|Kiểm tra email|20,2|Họp team|50
    if (
      serviceStr === 'sheets' &&
      actionParts.length > 0 &&
      String(actionParts[0]).toLowerCase() === 'update' &&
      actionParts.length >= 4
    ) {
      const range = String(actionParts[2] ?? '');
      let valuesTokens = actionParts.slice(3);
      // LLM sometimes includes literal token `--values` before the values payload.
      // gog treats values as positional tokens; keep semantics consistent by removing it.
      if (String(valuesTokens[0] ?? '').trim().toLowerCase() === '--values') {
        valuesTokens = valuesTokens.slice(1);
      }
      const valuesRaw = valuesTokens.join(' ').replace(/^['"]|['"]$/g, '').trim();
      let valuesConverted = false;

      // Case: LLM sometimes produces "JSON-like" arrays but uses `|` instead of commas, e.g.
      //   [["STT"|"Công việc"|"Tiến độ (%)"]|["1"|"Kiểm tra email"|"20"]]
      // Convert it to real JSON and use `--values-json`.
      if (valuesRaw.startsWith('[') && valuesRaw.includes('"|')) {
        const candidate = valuesRaw
          // row separator between arrays
          .replace(/\]\s*\|\s*\[/g, '],[')
          // cell separator inside a row
          .replace(/"\s*\|\s*"/g, '","');

        try {
          const parsed = JSON.parse(candidate);
          if (
            Array.isArray(parsed) &&
            parsed.every((row: any) => Array.isArray(row))
          ) {
            actionParts = actionParts
              .slice(0, 3)
              .concat(['--values-json', JSON.stringify(parsed)]);
            valuesConverted = true;
          }
        } catch {
          // ignore parse failure, fallback to other heuristics
        }
      }

      // Helper: compute number of columns from A1 range like "A2:C11" (or "Sheet1!A2:C11").
      const getColsCountFromRange = (a1Range: string): number | null => {
        const withoutSheet = a1Range.includes('!')
          ? a1Range.split('!').slice(1).join('!')
          : a1Range;
        const parts = withoutSheet.split(':');
        if (parts.length !== 2) return null;
        const start = parts[0];
        const end = parts[1];
        const startCol = start.replace(/[0-9]/g, '');
        const endCol = end.replace(/[0-9]/g, '');
        if (!startCol || !endCol) return null;

        const colToIndex = (col: string): number => {
          let idx = 0;
          const upper = col.toUpperCase();
          for (let i = 0; i < upper.length; i++) {
            const ch = upper.charCodeAt(i);
            // 'A'..'Z'
            idx = idx * 26 + (ch - 64);
          }
          return idx - 1;
        };

        const s = colToIndex(startCol);
        const e = colToIndex(endCol);
        const count = e - s + 1;
        return Number.isFinite(count) && count > 0 ? count : null;
      };

      // Extra format fixes for space-separated payloads (no `|`/`,`):
      // Example header update seen in your log:
      //   range=A1:C1 values="STT Công việc Tiến độ (%)"
      // Example data update seen in your log:
      //   range=A2:C11 values="1 Kiểm tra email 20% 2 Họp team 50% ..."
      if (!valuesConverted) {
        const cols = getColsCountFromRange(range);
        const hasAnyDelim = valuesRaw.includes('|') || valuesRaw.includes(',');

        // Header mapping for 3 columns: STT | Công việc | Tiến độ (%)
        if (
          cols === 3 &&
          !hasAnyDelim &&
          /stt/i.test(valuesRaw) &&
          /tien do/i.test(valuesRaw)
        ) {
          const norm = valuesRaw.replace(/\s+/g, ' ').trim();
          const lower = norm.toLowerCase();
          const sttIdx = lower.indexOf('stt');
          const tdIdx = lower.indexOf('tien do');
          if (sttIdx >= 0 && tdIdx > sttIdx) {
            const cell1 = 'STT';
            const cell2 = norm.slice(sttIdx + 'STT'.length, tdIdx).trim();
            const cell3 = norm.slice(tdIdx).trim(); // includes 'Tiến độ (%)'
            if (cell2 && cell3) {
              actionParts = actionParts
                .slice(0, 3)
                .concat([`${cell1}|${cell2}|${cell3}`]);
              valuesConverted = true;
            }
          }
        }

        // Data mapping for 3 columns from rows like:
        //   1 <task text> <percent>% 2 <task text> <percent>% ...
        if (
          cols === 3 &&
          !valuesConverted &&
          !hasAnyDelim &&
          valuesRaw.includes('%')
        ) {
          const segments =
            valuesRaw.match(/\d+\s+.*?(?=\s+\d+\s+|$)/g) ?? [];
          const rows: string[] = [];

          for (const segRaw of segments) {
            const seg = segRaw.trim();
            const m = seg.match(/^(\d+)\s+(.*?)\s+(\d+%?)\s*$/);
            if (!m) continue;
            const idx = m[1];
            const task = m[2].trim();
            const pct = m[3].trim();
            if (!task || !pct) continue;
            rows.push([idx, task, pct].join('|'));
          }

          if (rows.length > 0) {
            const newValues = rows.join(',');
            actionParts = actionParts.slice(0, 3).concat([newValues]);
            valuesConverted = true;
          }
        }
      }

      // Case: multi-line payload with `|` cells per row.
      // Example (from your log):
      //   STT|Công việc|Tiến độ (%)
      //   1|Kiểm tra email|20
      // gog expects rows separated by ',' (or better: values-json).
      // So convert to --values-json to preserve spaces inside cells.
      if (
        (valuesRaw.includes('\n') || valuesRaw.includes('\r')) &&
        valuesRaw.includes('|') &&
        !valuesRaw.includes(',') // avoid double-conversion if already correct
      ) {
        const lines = valuesRaw
          .split(/\r?\n/g)
          .map((l) => l.trim())
          .filter(Boolean);

        if (lines.length >= 1) {
          const rows = lines.map((line) =>
            line
              .split('|')
              .map((c) => c.trim())
              .filter((c) => c !== ''),
          );

          const valuesJson = JSON.stringify(rows);
          // Replace tail with values-json flag.
          actionParts = actionParts.slice(0, 3).concat(['--values-json', valuesJson]);
          valuesConverted = true;
        }
      }

      // Case: flattened row-major payload like:
      //   1|Kiểm tra email|20|2|Họp team|50|...|40
      // Range A2:C11 => 3 columns => group every 3 tokens into rows.
      if (!valuesConverted && valuesRaw.includes('|') && !valuesRaw.includes(',')) {
        const cols = getColsCountFromRange(range);
        if (cols) {
          const parts = valuesRaw
            .split('|')
            .map((c) => c.trim())
            .filter((c) => c.length > 0);
          if (parts.length >= cols && parts.length % cols === 0) {
            const rowCount = parts.length / cols;
            // Avoid huge accidental splits.
            if (rowCount > 0 && rowCount <= 200) {
              const rows = [];
              for (let i = 0; i < rowCount; i++) {
                const rowCells = parts.slice(i * cols, (i + 1) * cols).join('|');
                rows.push(rowCells);
              }
              const grouped = rows.join(',');
              if (grouped && grouped !== valuesRaw) {
                actionParts = actionParts.slice(0, 3).concat([grouped]);
                valuesConverted = true;
              }
            }
          }
        }
      }

      if (!valuesConverted && valuesRaw.includes('|') && valuesRaw.includes(',')) {
        // Assume: rows split by '|', cells split by ','.
        const rowParts = valuesRaw
          .split('|')
          .map((r) => r.trim())
          .filter(Boolean);
        const convertedRows = rowParts.map((row) => {
          const cells = row
            .split(',')
            .map((c) => c.trim())
            .filter((c) => c.length > 0);
          return cells.join('|');
        });

        const newValues = convertedRows.join(',');
        if (newValues && newValues !== valuesRaw) {
          actionParts = actionParts.slice(0, 3).concat([newValues]);
        }
      } else if (
        !valuesConverted &&
        !valuesRaw.includes('|') &&
        valuesRaw.includes(',')
      ) {
        // Likely single row/header: convert comma-separated cells → pipe-separated cells.
        const cells = valuesRaw
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c.length > 0);
        const newValues = cells.join('|');
        if (newValues && newValues !== valuesRaw && range.includes(':')) {
          actionParts = actionParts.slice(0, 3).concat([newValues]);
        }
      }
    }

    // Prevent duplicate spreadsheet creation with semantics:
    // - If spreadsheet with same normalized name exists in tracker (meaning: not in Trash list),
    //   then:
    //   - If it's very recent, reuse it (duplicate tool calls within same task/chain).
    //   - If it's older, treat this as a new task and create with suffix "(N)" after name.
    if (serviceStr === 'sheets' && actionParts.length > 0) {
      const verb = String(actionParts[0]).toLowerCase();
      if (verb === 'create') {
        const rest = actionParts.slice(1);
        const nextFlagIndex = rest.findIndex((p) => p.startsWith('--'));
        const titleTokens =
          nextFlagIndex >= 0 ? rest.slice(0, nextFlagIndex) : rest;
        const flagsTokens =
          nextFlagIndex >= 0 ? rest.slice(nextFlagIndex) : [];

        const sheetName = titleTokens.join(' ').trim();

        const parentFlagIndex = rest.findIndex((p) => p === '--parent');
        const parentId =
          parentFlagIndex >= 0 && rest[parentFlagIndex + 1]
            ? String(rest[parentFlagIndex + 1])
            : undefined;

        // Chỉ coi là "cùng tác vụ" khi trùng tên xảy ra rất gần nhau.
        // LLM lặp create trong cùng chuỗi thường xảy ra trong vài giây.
        // Nếu là nhắn lại ở tác vụ mới (phút), sẽ không reuse mà tạo thêm suffix.
        const RECENT_WINDOW_MS = 30 * 1000; // 30 seconds

        if (sheetName) {
          const existing = await this.driveTracker.findTrackedSpreadsheetByName(
            context.userId,
            sheetName,
            parentId,
          );

          if (existing) {
            const existingLastTs = Math.max(
              Date.parse(existing.updatedAt || existing.createdAt || ''),
              Date.parse(existing.createdAt || existing.updatedAt || ''),
            );

            const isRecent = Number.isFinite(existingLastTs)
              ? Date.now() - existingLastTs <= RECENT_WINDOW_MS
              : false;

            if (isRecent) {
              // Same task chain → reuse existing.
              return {
                success: true,
                data: {
                  id: existing.id,
                  spreadsheetId: existing.id,
                  name: existing.name,
                  url: existing.url,
                  sheets: existing.sheets ?? [],
                  skippedCreate: true,
                },
                metadata: {
                  durationMs: Date.now() - start,
                  service: serviceStr,
                  action: actionStr,
                  skippedCreate: true,
                  reuseExisting: true,
                  existingId: existing.id,
                },
              };
            }

            // New task but name duplicates → create new with "(N)" suffix.
            let candidateTitle: string | null = null;
            for (let i = 1; i <= 50; i++) {
              const t = `${sheetName} (${i})`;
              const found = await this.driveTracker.findTrackedSpreadsheetByName(
                context.userId,
                t,
                parentId,
              );
              if (!found) {
                candidateTitle = t;
                break;
              }
            }

            if (candidateTitle) {
              actionParts = [actionParts[0], candidateTitle, ...flagsTokens];
            }
          }
        }
      }
    }

    const args = [serviceStr, ...actionParts, ...extraParts];

    const result = await this.gogCli.exec({
      userId: context.userId,
      args,
      timeout: timeout as number,
      json: true,
    });

    // Verify drive delete actually removed the file (or only moved to trash).
    if (
      serviceStr === 'drive' &&
      driveDeleteFileId &&
      actionParts[0] === 'delete'
    ) {
      const verify = await this.gogCli.exec({
        userId: context.userId,
        args: ['drive', 'get', driveDeleteFileId],
        timeout: timeout as number,
        json: true,
      });

      // If we requested permanent deletion, file should not be found.
      if (appliedPermanent) {
        if (verify.success) {
          return {
            success: false,
            data: result.data,
            error:
              'Drive permanent delete executed but verification still found the file (might still exist in Trash or permanent delete failed).',
            metadata: {
              durationMs: Date.now() - start,
              service: serviceStr,
              action: actionStr,
              stderr: result.stderr,
              appliedPermanent,
              verification: verify.data,
            },
          };
        }
      }

      // Non-permanent delete: success with file still found is expected (file is in Trash).
      if (!appliedPermanent && verify.success) {
        return {
          success: true,
          data: result.data,
          error: result.error,
          metadata: {
            durationMs: Date.now() - start,
            service: serviceStr,
            action: actionStr,
            stderr: result.stderr,
            appliedPermanent,
            deletionResult: 'deleted_to_trash',
            verification: verify.data,
          },
        };
      }
    }

    // Auto-track: ghi nhớ file/folder/sheet đã tạo, sửa, xóa vào GOOGLE_DRIVE.md
    // IMPORTANT: we await to keep state consistent inside the same agent loop
    // (avoid repeated "create" calls generating duplicates).
    try {
      await this.driveTracker.trackOperation(
        context.userId,
        service as string,
        action as string,
        result.data,
        result.success,
      );
    } catch (err: any) {
      this.logger.warn(`Drive tracking failed: ${err?.message ?? err}`);
    }

    return {
      success: result.success,
      data: result.data,
      error: result.error,
      metadata: {
        durationMs: Date.now() - start,
        service: serviceStr,
        action: actionStr,
        stderr: result.stderr,
        appliedPermanent,
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
  private buildArgs(
    service: string,
    action: string,
    extraArgs?: string,
  ): string[] {
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
