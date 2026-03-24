import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  ThreadResolverService,
  ResolvedThread,
} from './session-resolver/session-resolver.service';
import { WorkspaceService } from './workspace/workspace.service';
import { SessionContextFocusService } from './workspace/session-context-focus.service';
import { AgentService } from '../agent/agent.service';
import { ChatService } from '../modules/chat/chat.service';
import { SkillsService } from '../agent/skills/skills.service';
import { IInboundMessage } from '../agent/channels/interfaces/channel.interface';
import { MessageRole } from '../modules/chat/entities/chat-message.entity';
import { ChatPlatform } from '../modules/chat/entities/chat-thread.entity';
import { IPipelineContext } from '../agent/pipeline/interfaces/pipeline-context.interface';
import { ConfigService } from '@nestjs/config';
import { StopAllService } from '../agent/control/stop-all.service';
import { User, UserLevel } from '../modules/users/entities/user.entity';
import { UsersService } from '../modules/users/users.service';
import { ThreadsService } from '../modules/chat/threads.service';
import { OpenclawChatService } from '../modules/openclaw-agents/openclaw-chat.service';
import { PreferenceExtractorService } from '../agent/learning/preference-extractor.service';
import { createHash } from 'crypto';
import { buildMenuHelpText } from '../modules/bot-users/bot-platform-menu';
import { sanitizeLlmDisplayLeakage } from '../modules/bot-users/llm-output-sanitize';
import { TasksService } from '../modules/tasks/tasks.service';
import { TaskWorkflowsService } from '../modules/task-workflows/task-workflows.service';

/**
 * GatewayService — trung tâm điều phối giữa entry points và agent pipeline.
 *
 * 1. Nhận request từ REST / WebSocket / Webhook
 * 2. Resolve thread per-user per-platform
 * 3. Load conversation context
 * 4. Đẩy vào pipeline
 * 5. Persist kết quả
 * 6. Trả response
 *
 * Xử lý song song: mỗi user request là 1 async operation độc lập.
 */
@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  // Idempotency / de-dup: avoid re-processing same inbound request
  // when upstream (telegram webhook/polling, retries) re-sends it.
  private readonly recentInboundKeys = new Map<string, number>(); // key -> firstSeenAtMs
  private readonly recentInboundTtlDefaultMs = 10 * 1000; // 10s for content-hash
  private readonly recentInboundTtlWithIdMs = 5 * 60 * 1000; // 5m for explicit upstream id

  /** Đếm lượt assistant reply per thread — trigger preference extraction mỗi N lượt. */
  private readonly prefExtractTurnCount = new Map<string, number>();

  /**
   * Đếm số pipeline đang chạy đồng thời per-user (userId → count).
   * Ngăn 1 user spam nhiều request song song, gây nghẽn LLM API và DB.
   * Giới hạn: owner=3, colleague=2, client=1 (có thể override qua ENV).
   */
  private readonly activeRunsPerUser = new Map<number, number>();

  private getMaxConcurrentRuns(level: UserLevel): number {
    switch (level) {
      case UserLevel.OWNER:
        return Number(
          this.configService.get('MAX_CONCURRENT_RUNS_OWNER', '3'),
        );
      case UserLevel.COLLEAGUE:
        return Number(
          this.configService.get('MAX_CONCURRENT_RUNS_COLLEAGUE', '2'),
        );
      default:
        return Number(
          this.configService.get('MAX_CONCURRENT_RUNS_CLIENT', '1'),
        );
    }
  }

  private isDuplicateInbound(key: string, ttlMs: number): boolean {
    const now = Date.now();
    const prev = this.recentInboundKeys.get(key);
    if (typeof prev === 'number' && now - prev <= ttlMs) {
      return true;
    }
    this.recentInboundKeys.set(key, now);

    // Soft cleanup (avoid unbounded growth).
    if (this.recentInboundKeys.size > 5000) {
      const sorted = [...this.recentInboundKeys.entries()].sort(
        (a, b) => a[1] - b[1],
      );
      for (const [k] of sorted.slice(0, 800)) {
        this.recentInboundKeys.delete(k);
      }
    }

    return false;
  }

  /** Slash segment đã dùng cho gateway — không map sang tool trực tiếp. */
  private readonly gatewayReservedSlashSegments = new Set([
    'stop',
    'resume',
    'stopall',
    'resumeall',
    'new_session',
    'list_tools',
    'list_skills',
    'list_other_skills',
    'list_orther_skills',
    'run_skill',
    'delete_skill',
    'update_skill',
    'tool',
    'clean_media_incoming',
    'brain_tree',
    'brain_read',
    'oa',
    'agents',
  ]);

  private parseSimpleParams(input: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const re = /([a-zA-Z_][a-zA-Z0-9_]*)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g;
    let m: RegExpExecArray | null = null;
    while ((m = re.exec(input)) !== null) {
      const key = m[1];
      const raw = m[2];
      const val =
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
          ? raw.slice(1, -1)
          : raw;
      if (val === 'true') out[key] = true;
      else if (val === 'false') out[key] = false;
      else if (/^-?\d+(?:\.\d+)?$/.test(val)) out[key] = Number(val);
      else out[key] = val;
    }
    return out;
  }

  /** Khớp code đăng ký (đúng key hoặc không phân biệt hoa thường). */
  private resolveRegisteredToolCode(raw: string): string | undefined {
    const r = raw.trim();
    if (!r) return undefined;
    if (this.skillsService.getRunner(r)) return r;
    const lower = r.toLowerCase();
    for (const d of this.skillsService.listCodeSkills()) {
      if (d.code.toLowerCase() === lower) return d.code;
    }
    return undefined;
  }

  private parseParamsFromRestOrFail(
    raw: string,
    errorPrefix: string,
  ):
    | { ok: true; params: Record<string, unknown> }
    | { ok: false; message: string } {
    const rawParams = (raw || '').trim();
    if (!rawParams) {
      return { ok: true, params: {} };
    }
    if (rawParams.startsWith('{')) {
      try {
        const parsed = JSON.parse(rawParams);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ok: true, params: parsed as Record<string, unknown> };
        }
        return {
          ok: false,
          message: `${errorPrefix}: JSON phải là object.`,
        };
      } catch {
        return { ok: false, message: `${errorPrefix}: JSON không hợp lệ.` };
      }
    }
    return { ok: true, params: this.parseSimpleParams(rawParams) };
  }

  /**
   * Quét toàn bộ tin nhắn: `/tool_code` và `@tool_code` (một token, không khoảng trắng trong tên)
   * → gợi ý cho agent. Bỏ qua `/` trong URL (đứng sau chữ/số).
   */
  private collectToolHintsFromText(text: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    const slashRe = /\/([a-zA-Z0-9_]+)(?:@\S+)?/g;
    let m: RegExpExecArray | null;
    while ((m = slashRe.exec(text)) !== null) {
      const idx = m.index ?? 0;
      if (idx > 0 && /[a-zA-Z0-9]/.test(text[idx - 1]!)) continue;
      const rawSeg = m[1]!;
      const seg = rawSeg.toLowerCase();
      if (this.gatewayReservedSlashSegments.has(seg)) continue;
      const code = this.resolveRegisteredToolCode(rawSeg);
      if (code && !seen.has(code)) {
        seen.add(code);
        out.push(code);
      }
    }

    const atRe = /(?<![a-zA-Z0-9])@([a-zA-Z0-9_]+)\b/g;
    while ((m = atRe.exec(text)) !== null) {
      const code = this.resolveRegisteredToolCode(m[1]!);
      if (code && !seen.has(code)) {
        seen.add(code);
        out.push(code);
      }
    }

    return out;
  }

  private buildPipelineUserContent(
    original: string,
    hints: string[],
  ): string {
    if (!hints.length) return original;
    return (
      `[Hệ thống] Người dùng chỉ định dùng tool: ${hints.join(', ')} — ` +
      `thực hiện yêu cầu bằng các tool này (gọi tool thật), không chỉ mô tả.\n\n` +
      original
    );
  }

  private async persistAssistantReply(
    user: { uid: number; identifier: string },
    threadId: string,
    content: string,
    tokensUsed = 0,
  ): Promise<void> {
    await this.chatService.createMessage({
      threadId,
      userId: user.uid,
      role: MessageRole.ASSISTANT,
      content,
      tokensUsed,
    });
    this.workspaceService.appendSessionEntry(user.identifier, threadId, {
      type: 'message',
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: sanitizeLlmDisplayLeakage(content),
      },
      tokensUsed,
    });
    this.sessionContextFocusService.scheduleRefreshAfterAssistantMessage({
      userId: user.uid,
      identifier: user.identifier,
      threadId,
    });

    // Trigger preference extraction mỗi N lượt (mặc định 5)
    if (this.preferenceExtractor) {
      const interval = this.resolvePrefExtractInterval();
      const count = (this.prefExtractTurnCount.get(threadId) ?? 0) + 1;
      this.prefExtractTurnCount.set(threadId, count);
      if (count % interval === 0) {
        this.preferenceExtractor.scheduleExtraction({
          userId: user.uid,
          threadId,
        });
      }
    }
  }

  private async tryHandleCommandFirst(
    content: string,
    context: {
      userId: number;
      threadId: string;
      actorTelegramId?: string;
      userIdentifier: string;
    },
  ): Promise<{ handled: true; response: string } | { handled: false }> {
    const text = (content || '').trim();

    if (!text.startsWith('/')) return { handled: false };

    const isMenuOrBrainCommand =
      /^\/menu(?:@\S+)?$/i.test(text) ||
      /^\/brain_tree(?:@\S+)?$/i.test(text) ||
      /^\/brain_read(?:@\S+)?(?:\s|$)/i.test(text);
    if (isMenuOrBrainCommand) {
      const u = await this.usersService.findById(context.userId);
      if (u?.level === UserLevel.CLIENT) {
        return {
          handled: true,
          response:
            'Tài khoản client chỉ dùng để chat; không hỗ trợ /menu, /brain_tree hay /brain_read.',
        };
      }
    }

    if (/^\/menu(?:@\S+)?$/i.test(text)) {
      return { handled: true, response: buildMenuHelpText() };
    }

    if (/^\/clean_media_incoming(?:@\S+)?$/i.test(text)) {
      const result = await this.workspaceService.cleanUserMediaIncomingDir(
        context.userIdentifier,
      );
      const loc = this.workspaceService.userBrainDisplayPath(
        context.userIdentifier,
        result.path,
        { isDirectory: true },
      );
      const lines = [
        result.removed === 0
          ? 'Không có file hay thư mục con nào trong media/incoming.'
          : `Đã xóa ${result.removed} mục trong thư mục media/incoming.`,
        `Vị trí: ${loc}`,
      ];
      if (result.errors.length) {
        lines.push('Lỗi một phần:', ...result.errors);
      }
      return { handled: true, response: lines.join('\n') };
    }

    if (/^\/brain_tree(?:@\S+)?$/i.test(text)) {
      const out = await this.workspaceService.listUserBrainDirectoryTree(
        context.userIdentifier,
      );
      return { handled: true, response: out };
    }

    const brainReadMatch = text.match(/^\/brain_read(?:@\S+)?(?:\s+([\s\S]*))?$/i);
    if (brainReadMatch) {
      const rel = (brainReadMatch[1] ?? '').trim();
      const r = this.workspaceService.readUserBrainPath(
        context.userIdentifier,
        rel,
      );
      if (r.kind === 'error') {
        return { handled: true, response: `❌ ${r.error}` };
      }
      if (r.kind === 'directory') {
        return { handled: true, response: r.listing };
      }
      const displayPath = this.workspaceService.userBrainDisplayPath(
        context.userIdentifier,
        r.absolutePath,
        { isDirectory: false },
      );
      return {
        handled: true,
        response: `File: ${displayPath}\n\n---\n${r.content}\n---`,
      };
    }

    if (/^\/list_tools(?:@\S+)?$/i.test(text) || /^\/list_skills(?:@\S+)?$/i.test(text)) {
      const tools = this.skillsService.listCodeSkills().map((s) => s.code).sort();
      return {
        handled: true,
        response: `Tools/skills hiện có (${tools.length}):\n- ${tools.join('\n- ')}`,
      };
    }

    // Skill gói trên đĩa: $BRAIN_DIR/_shared/skills/<code>/ (alias lệnh gõ nhầm list_orther_skills)
    if (
      /^\/list_other_skills(?:@\S+)?$/i.test(text) ||
      /^\/list_orther_skills(?:@\S+)?$/i.test(text)
    ) {
      const result = await this.skillsService.executeSkill('skills_registry_manage', {
        userId: context.userId,
        threadId: context.threadId,
        actorTelegramId: context.actorTelegramId,
        runId: `cmd-list-other-skills-${Date.now()}`,
        parameters: { action: 'list_registry' },
      });
      return { handled: true, response: JSON.stringify(result, null, 2) };
    }

    const runSkillMatch = text.match(
      /^\/run_skill(?:@\S+)?\s+([a-zA-Z0-9_.-]+)\s*([\s\S]*)$/i,
    );
    if (runSkillMatch) {
      const skillCode = runSkillMatch[1].trim();
      const rawParams = (runSkillMatch[2] || '').trim();
      const parsed = this.parseParamsFromRestOrFail(
        rawParams,
        '❌ /run_skill',
      );
      if (parsed.ok === false) {
        return {
          handled: true,
          response:
            parsed.message +
            ' Ví dụ: /run_skill facebook_post_status_v2 {"content":"Xin chào"}',
        };
      }
      const runtimeParams = parsed.params;

      const result = await this.skillsService.executeSkill('skills_registry_manage', {
        userId: context.userId,
        threadId: context.threadId,
        actorTelegramId: context.actorTelegramId,
        runId: `cmd-run-skill-${Date.now()}`,
        parameters: {
          action: 'run_skill',
          skillCode,
          runtimeParams,
        },
      });
      return {
        handled: true,
        response: JSON.stringify(result, null, 2),
      };
    }

    const deleteSkillMatch = text.match(
      /^\/delete_skill(?:@\S+)?\s+([a-zA-Z0-9_.-]+)\s*$/i,
    );
    if (deleteSkillMatch) {
      const skillCode = deleteSkillMatch[1].trim();
      const result = await this.skillsService.executeSkill(
        'skills_registry_manage',
        {
          userId: context.userId,
          threadId: context.threadId,
          actorTelegramId: context.actorTelegramId,
          runId: `cmd-delete-skill-${Date.now()}`,
          parameters: {
            action: 'delete_skill',
            skillCode,
            confirmDelete: true,
          },
        },
      );
      return { handled: true, response: JSON.stringify(result, null, 2) };
    }

    const updateSkillMatch = text.match(
      /^\/update_skill(?:@\S+)?\s+([a-zA-Z0-9_.-]+)\s*([\s\S]*)$/i,
    );
    if (updateSkillMatch) {
      const skillCode = updateSkillMatch[1].trim();
      const rawParams = (updateSkillMatch[2] || '').trim();
      const parsed = this.parseParamsFromRestOrFail(
        rawParams,
        '❌ /update_skill',
      );
      if (parsed.ok === false) {
        return {
          handled: true,
          response:
            parsed.message +
            ' Ví dụ: /update_skill facebook_post_personal_v2 {"description":"..."}',
        };
      }
      if (Object.keys(parsed.params).length === 0) {
        return {
          handled: true,
          response:
            '❌ /update_skill cần phần patch (JSON object hoặc key=value). ' +
            'Ví dụ: /update_skill my_skill {"executionNotes":"..."}',
        };
      }
      const result = await this.skillsService.executeSkill(
        'skills_registry_manage',
        {
          userId: context.userId,
          threadId: context.threadId,
          actorTelegramId: context.actorTelegramId,
          runId: `cmd-update-skill-${Date.now()}`,
          parameters: {
            action: 'update_skill',
            skillCode,
            confirmUpdate: true,
            patch: parsed.params,
            regenerateReadme: true,
          },
        },
      );
      return { handled: true, response: JSON.stringify(result, null, 2) };
    }

    const toolMatch = text.match(/^\/tool(?:@\S+)?\s+([a-zA-Z0-9_.-]+)\s*([\s\S]*)$/i);
    if (toolMatch) {
      const toolCode = toolMatch[1].trim();
      const rawJson = (toolMatch[2] || '').trim();
      if (!rawJson) {
        return {
          handled: true,
          response:
            '❌ /tool thiếu JSON params. Ví dụ: /tool_browser {"action":"navigate","url":"https://example.com"} (hoặc dạng cũ: /tool browser {"action":...})',
        };
      }
      let parameters: Record<string, unknown>;
      try {
        const parsed = JSON.parse(rawJson);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('invalid');
        }
        parameters = parsed as Record<string, unknown>;
      } catch {
        return { handled: true, response: '❌ /tool JSON params không hợp lệ.' };
      }

      const result = await this.skillsService.executeSkill(toolCode, {
        userId: context.userId,
        threadId: context.threadId,
        actorTelegramId: context.actorTelegramId,
        runId: `cmd-tool-${Date.now()}`,
        parameters,
      });
      return { handled: true, response: JSON.stringify(result, null, 2) };
    }

    // /run_task <task_id|task_code>
    const runTaskMatch = text.match(/^\/run_task(?:@\S+)?\s+(\S+)\s*$/i);
    if (runTaskMatch) {
      const taskRef = runTaskMatch[1].trim();
      const u = await this.usersService.findById(context.userId);
      if (!u || u.level === UserLevel.CLIENT) {
        return {
          handled: true,
          response: '❌ Chỉ owner và colleague mới có thể chạy task.',
        };
      }
      try {
        const taskId = Number(taskRef);
        const tasks = await this.tasksService.list(context.userId);
        const target = !isNaN(taskId)
          ? tasks.find((t) => t.id === taskId)
          : tasks.find((t) => t.code === taskRef);
        if (!target) {
          return {
            handled: true,
            response: `❌ Không tìm thấy task "${taskRef}". Dùng /run_task <task_id> hoặc /run_task <task_code>.`,
          };
        }
        const { runId } = await this.tasksService.enqueueRunForUser(target.id, context.userId);
        return {
          handled: true,
          response: `✅ Đã enqueue task "${target.name}" (code: ${target.code}).\nRun ID: ${runId}\nKiểm tra tiến trình qua API: GET /tasks/runs/${runId}`,
        };
      } catch (e) {
        return {
          handled: true,
          response: `❌ Lỗi khi chạy task: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    // /run_workflow <workflow_id>
    const runWorkflowMatch = text.match(/^\/run_workflow(?:@\S+)?\s+(\d+)\s*$/i);
    if (runWorkflowMatch) {
      const wfId = parseInt(runWorkflowMatch[1], 10);
      const u = await this.usersService.findById(context.userId);
      if (!u || u.level === UserLevel.CLIENT) {
        return {
          handled: true,
          response: '❌ Chỉ owner và colleague mới có thể chạy workflow.',
        };
      }
      try {
        const { runId } = await this.taskWorkflowsService.enqueueRunForUser(wfId, context.userId);
        return {
          handled: true,
          response: `✅ Đã enqueue workflow #${wfId}.\nRun ID: ${runId}\nKiểm tra tiến trình qua API: GET /task-workflows/runs/${runId}`,
        };
      } catch (e) {
        return {
          handled: true,
          response: `❌ Lỗi khi chạy workflow: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    return { handled: false };
  }

  constructor(
    private readonly sessionContextFocusService: SessionContextFocusService,
    private readonly threadResolver: ThreadResolverService,
    private readonly workspaceService: WorkspaceService,
    private readonly agentService: AgentService,
    private readonly chatService: ChatService,
    private readonly threadsService: ThreadsService,
    private readonly openclawChatService: OpenclawChatService,
    private readonly skillsService: SkillsService,
    private readonly configService: ConfigService,
    private readonly stopAllService: StopAllService,
    private readonly usersService: UsersService,
    private readonly tasksService: TasksService,
    private readonly taskWorkflowsService: TaskWorkflowsService,
    @Optional() private readonly preferenceExtractor?: PreferenceExtractorService,
  ) {}

  /**
   * Read pronoun/honorific rules from per-user workspace MEMORY.md.
   *
   * Example MEMORY.md:
   * - Xưng hô: Sếp
   * - Cách xưng hô: Em (Mira) - Sếp (Khánh)
   *
   * Fallbacks:
   * - userTitle: 'bạn'
   * - botTitle: 'tôi'
   */
  private getHonorificsForUser(identifier: string): {
    userTitle: string;
    botTitle: string;
  } {
    try {
      const memory = this.workspaceService.readWorkspaceFile(
        identifier,
        'MEMORY.md',
      );
      const userTitleMatch = memory?.match(
        /^-\s*Xưng hô\s*:\s*(.+)\s*$/im,
      );

      // Bot/user titles extracted from: "Cách xưng hô: Em (Mira) - Sếp (Khánh)"
      const cáchXungHoMatch = memory?.match(
        /^-\s*Cách xưng hô\s*:\s*(.+)\s*$/im,
      );

      let botTitle: string | undefined;
      let userTitle: string | undefined;

      if (cáchXungHoMatch?.[1]) {
        const parts = cáchXungHoMatch[1].split('-').map((s) => s.trim());
        const left = parts[0] ?? '';
        const right = parts[1] ?? '';

        // left: "Em (Mira)" -> botTitle="Em"
        botTitle = left.split('(')[0].trim() || undefined;
        // right: "Sếp (Khánh)" -> userTitle="Sếp"
        userTitle = right.split('(')[0].trim() || undefined;
      }

      return {
        userTitle: userTitle ?? userTitleMatch?.[1]?.trim() ?? 'bạn',
        botTitle: botTitle ?? 'tôi',
      };
    } catch {
      return { userTitle: 'bạn', botTitle: 'tôi' };
    }
  }

  /**
   * OpenClaw chỉ dành cho chủ bot (cùng platform id với user); grantee không dùng được.
   */
  private isActorOwner(
    user: User,
    platform: ChatPlatform,
    options?: {
      telegramUserId?: string;
      zaloUserId?: string;
      discordUserId?: string;
    },
  ): boolean {
    if (platform === ChatPlatform.WEB) return true;
    if (platform === ChatPlatform.FACEBOOK) return true;
    if (platform === ChatPlatform.TELEGRAM) {
      const a = String(options?.telegramUserId ?? '').trim();
      const o = String(user.telegramId ?? '').trim();
      return !!a && !!o && a === o;
    }
    if (platform === ChatPlatform.ZALO) {
      const a = String(options?.zaloUserId ?? '').trim();
      const o = String(user.zaloId ?? '').trim();
      return !!a && !!o && a === o;
    }
    if (platform === ChatPlatform.DISCORD) {
      const a = String(options?.discordUserId ?? '').trim();
      const o = String(user.discordId ?? '').trim();
      return !!a && !!o && a === o;
    }
    if (platform === ChatPlatform.SLACK) {
      return true;
    }
    return true;
  }

  /**
   * Khi client gửi threadId cụ thể → dùng thread đó (nếu thuộc user), bỏ qua auto-resolve.
   * Cho phép multi-session giống Cursor.
   */
  private async resolveExplicitThread(
    userId: number,
    threadId: string,
  ): Promise<ResolvedThread | null> {
    const specific = await this.threadsService.findById(threadId);
    if (!specific || specific.userId !== userId) return null;
    const user = await this.usersService.findById(userId);
    if (!user) return null;
    await this.workspaceService.ensureUserWorkspace(user.identifier);
    await this.threadsService.touch(specific.id);
    return { user, thread: specific, isNew: false };
  }

  async handleMessage(
    userId: number,
    content: string,
    options?: {
      channelId?: string;
      platform?: ChatPlatform;
      telegramUserId?: string;
      zaloUserId?: string;
      discordUserId?: string;
      model?: string;
      /** Unique upstream request id (e.g. Telegram update_id, Discord interaction.id) */
      dedupId?: string;
      /** URL tài nguyên công khai (REST / một số tích hợp) */
      mediaUrl?: string;
      /** Đường dẫn file đã lưu trên server (vd. sau khi tải từ Telegram) */
      mediaPath?: string;
      /** Nhiều file trong cùng một lượt (vd. album Telegram) */
      mediaPaths?: string[];
      threadId?: string;
    },
  ): Promise<{
    response: string;
    threadId: string;
    tokensUsed: number;
    runId: string;
  }> {
    const platform = options?.platform ?? ChatPlatform.WEB;

    const actor = {
      telegramId: options?.telegramUserId,
      zaloId: options?.zaloUserId,
      discordId: options?.discordUserId,
    };

    let { user, thread, isNew } = options?.threadId
      ? (await this.resolveExplicitThread(userId, options.threadId)) ??
        (await this.threadResolver.resolve(userId, platform, actor))
      : await this.threadResolver.resolve(userId, platform, actor);

    const normalized = content.trim().toLowerCase();

    // Command: force-create a new session note + reset chat thread.
    // Allow Telegram suffix like "/new_session@BotName".
    // Accept common typos like "/new_sesssion" (extra "s") + optional "@BotName" suffix.
    const isNewSessionCommand = /^\/new_sess+ion(?:@\S+)?$/.test(normalized);
    if (normalized === '/stopall') {
      if (
        user.level !== UserLevel.OWNER &&
        user.level !== UserLevel.COLLEAGUE
      ) {
        return {
          response: '⛔ Chỉ owner và colleague mới có quyền dùng /stopall.',
          threadId: thread.id,
          tokensUsed: 0,
          runId: `stop-denied-${Date.now()}`,
        };
      }
      this.stopAllService.activateStop(user.uid, '/stopall command');
      return {
        response:
          '🛑 Đã kích hoạt STOP ALL. Toàn bộ tác vụ mới sẽ bị chặn và các pipeline đang chạy sẽ dừng sớm nhất có thể.',
        threadId: thread.id,
        tokensUsed: 0,
        runId: `stopall-${Date.now()}`,
      };
    }

    if (normalized === '/resumeall') {
      if (user.level !== UserLevel.OWNER) {
        return {
          response: '⛔ Chỉ owner mới có quyền dùng /resumeall.',
          threadId: thread.id,
          tokensUsed: 0,
          runId: `resume-denied-${Date.now()}`,
        };
      }
      this.stopAllService.resume(user.uid);
      return {
        response:
          '✅ Đã tắt STOP ALL. Hệ thống xử lý tác vụ bình thường trở lại.',
        threadId: thread.id,
        tokensUsed: 0,
        runId: `resumeall-${Date.now()}`,
      };
    }

    if (normalized === '/stop') {
      this.stopAllService.activateUserStop(user.uid, '/stop command');
      const { userTitle, botTitle } = this.getHonorificsForUser(user.identifier);
      return {
        response:
          `🛑 Dạ, ${botTitle} đã dừng các tác vụ của riêng ${userTitle}. ` +
          `${userTitle} gửi /resume để ${botTitle} tiếp tục xử lý cho tài khoản này.`,
        threadId: thread.id,
        tokensUsed: 0,
        runId: `stop-${user.uid}-${Date.now()}`,
      };
    }

    if (normalized === '/resume') {
      this.stopAllService.resumeUser(user.uid);
      return {
        response: '✅ Đã bật lại xử lý tác vụ cho tài khoản của bạn.',
        threadId: thread.id,
        tokensUsed: 0,
        runId: `resume-${user.uid}-${Date.now()}`,
      };
    }

    // Natural-language stop (no leading slash):
    // This allows user to say "dừng tác vụ / dừng lại / ngừng lại / cancel / stop" directly.
    // Keep it strict to avoid matching normal conversational sentences.
    const isNaturalStop =
      /^(?:\/)?(d(ừ)?ng|dung|n(ừ)?g|ngung|ngừng|ngung|stop|halt|cancel|h(ủy|uỷ)|huy|huỷ)\b/i.test(
        normalized,
      ) &&
      !/(\bgoogle\b|\bdrive\b|\bsheets\b|\bemail\b|\bcrypto\b|\bdọn\b|\bxóa\b|\bdelete\b)/i.test(
        normalized,
      );

    if (isNaturalStop) {
      this.stopAllService.activateUserStop(user.uid, '/stop (natural language)');
      const { userTitle, botTitle } = this.getHonorificsForUser(user.identifier);
      return {
        response:
          `🛑 Dạ, ${botTitle} đã dừng các tác vụ của riêng ${userTitle}. ` +
          `${userTitle} gửi /resume để ${botTitle} tiếp tục xử lý cho tài khoản này.`,
        threadId: thread.id,
        tokensUsed: 0,
        runId: `stop-natural-${user.uid}-${Date.now()}`,
      };
    }

    if (this.stopAllService.isStoppedForUser(user.uid)) {
      const state = this.stopAllService.getUserState(user.uid);
      const ownerHint =
        state.scope === 'global'
          ? '\nOwner có thể dùng /resumeall để mở lại.'
          : '\nBạn có thể dùng /resume để mở lại xử lý cho mình.';
      return {
        response:
          `🛑 Hệ thống đang dừng xử lý (${state.scope}) từ ${state.stoppedAt?.toISOString() ?? 'unknown'}.` +
          ownerHint,
        threadId: thread.id,
        tokensUsed: 0,
        runId: `stopped-${Date.now()}`,
      };
    }

    // Backend-guard: if user asks to create a new "session note" file,
    // ensure we always create it in the correct folder path.
    // Also: when the user is owner, reset thread FIRST so `chat_threads`
    // gets a new row and messages are stored in the new thread.
    // Use includes (no word boundaries) to avoid Unicode \b issues with Vietnamese chars.
    const lc = content.trim().toLowerCase();
    const lcNoAccent = lc.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    const wantsNewSessionNote =
      (lcNoAccent.includes('session') &&
        (lcNoAccent.includes('moi') || lc.includes('mới'))) ||
      (lcNoAccent.includes('phien') &&
        lcNoAccent.includes('chat') &&
        (lcNoAccent.includes('moi') || lc.includes('mới'))) ||
      isNewSessionCommand;

    if (wantsNewSessionNote && user.level === UserLevel.OWNER) {
      // If resolve() created a new thread just now (no active thread yet),
      // then reset() will create another one => "thừa 1 dòng" trong chat_threads.
      // To keep DB clean, delete the transient thread created by resolve().
      const transientThreadId = isNew ? thread.id : null;

      const reset = await this.threadResolver.reset(user.uid, platform, actor);
      user = reset.user;
      thread = reset.thread;
      isNew = reset.isNew;
      this.logger.log(
        `[${user.identifier}] Reset thread due to session-note request: thread=${thread.id}`,
      );

      if (transientThreadId) {
        await this.threadResolver.deleteThread(transientThreadId);
      }
    }

    this.logger.log(
      `[${user.identifier}] Message received (thread: ${thread.id}, new: ${isNew}, platform: ${platform})`,
    );

    const pathsFromOpts =
      options?.mediaPaths?.filter(
        (p): p is string => typeof p === 'string' && !!p.trim(),
      ) ?? [];
    const singlePath = options?.mediaPath?.trim();
    let mediaBlock = '';
    if (pathsFromOpts.length > 1) {
      mediaBlock =
        `\n\n(${pathsFromOpts.length} file đính kèm — đường dẫn thật trên server:\n` +
        pathsFromOpts.map((p, i) => `${i + 1}. ${p.trim()}`).join('\n') +
        ')';
    } else if (pathsFromOpts.length === 1) {
      mediaBlock = `\n\n(File đính kèm — đường dẫn thật trên server: ${pathsFromOpts[0]!.trim()})`;
    } else if (singlePath) {
      mediaBlock = `\n\n(File đính kèm — đường dẫn thật trên server: ${singlePath})`;
    }
    const effectiveContent = `${content.trim()}${mediaBlock}`.trim();

    // De-dup before persisting/sending anything.
    const sourceChannelId = options?.channelId || platform || 'web';
    const rawDedupId = options?.dedupId;
    if (rawDedupId && String(rawDedupId).trim()) {
      const key = `dedup:${sourceChannelId}:${String(rawDedupId).trim()}`;
      if (this.isDuplicateInbound(key, this.recentInboundTtlWithIdMs)) {
        return {
          response: '',
          threadId: thread.id,
          tokensUsed: 0,
          runId: `dedup-${Date.now()}`,
        };
      }
    } else if (sourceChannelId === 'webchat') {
      // ChatGateway/WebChat: upstream doesn't provide messageId.
      // Use a short TTL content-hash to block rapid retries.
      const normalized = (effectiveContent || '').trim().toLowerCase();
      const hash = createHash('sha1').update(normalized).digest('hex');
      const key = `dedup:${sourceChannelId}:${user.uid}:${hash}`;
      if (this.isDuplicateInbound(key, this.recentInboundTtlDefaultMs)) {
        return {
          response: '',
          threadId: thread.id,
          tokensUsed: 0,
          runId: `dedup-${Date.now()}`,
        };
      }
    }

    const fullThread =
      (await this.threadsService.findById(thread.id)) ?? thread;

    const actorOwner = this.isActorOwner(user, platform, options);
    const ocSlash =
      this.openclawChatService.isOpenclawSlashCommand(effectiveContent);

    const inOpenclawChat =
      !!fullThread.activeOpenclawAgentId && actorOwner && !ocSlash;

    if (inOpenclawChat) {
      const { userTitle, botTitle } = this.getHonorificsForUser(user.identifier);
      const result = await this.openclawChatService.handleUserTurn({
        user,
        thread: fullThread,
        platform,
        effectiveContent,
        honorifics: { userTitle, botTitle },
      });
      return {
        response: result.response,
        threadId: thread.id,
        tokensUsed: 0,
        runId: result.runId,
      };
    }

    await this.chatService.createMessage({
      threadId: thread.id,
      userId: user.uid,
      telegramId:
        platform === ChatPlatform.TELEGRAM
          ? options?.telegramUserId
          : undefined,
      zaloId:
        platform === ChatPlatform.ZALO ? options?.zaloUserId : undefined,
      discordId:
        platform === ChatPlatform.DISCORD ? options?.discordUserId : undefined,
      role: MessageRole.USER,
      content: effectiveContent,
    });

    this.workspaceService.appendSessionEntry(user.identifier, thread.id, {
      type: 'message',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: effectiveContent },
    });

    if (ocSlash && actorOwner) {
      const slash = await this.openclawChatService.tryHandleSlashCommands({
        user,
        thread: fullThread,
        platform,
        text: effectiveContent,
        telegramUserId: options?.telegramUserId,
        zaloUserId: options?.zaloUserId,
        discordUserId: options?.discordUserId,
      });
      if (slash.handled && slash.response !== undefined) {
        await this.persistAssistantReply(user, thread.id, slash.response, 0);
        return {
          response: slash.response,
          threadId: thread.id,
          tokensUsed: 0,
          runId: `openclaw-cmd-${Date.now()}`,
        };
      }
    }

    if (ocSlash && !actorOwner) {
      const denied =
        '⛔ Chỉ chủ tài khoản bot mới dùng lệnh OpenClaw (/agents, /oa ...).';
      await this.persistAssistantReply(user, thread.id, denied, 0);
      return {
        response: denied,
        threadId: thread.id,
        tokensUsed: 0,
        runId: `openclaw-denied-${Date.now()}`,
      };
    }

    // Dump request: if user asks to show "all messages" of the current session/thread,
    // return from DB directly to avoid the agent drifting into unrelated tool actions
    // based on previous context.
    const wantsThreadMessageDump =
      /\b(session|phiên|phien)\b/i.test(normalized) &&
      /\b(toàn\s*bộ|toan\s*bo|tất\s*cả|tat\s*ca|liệt\s*kê|liet\s*ke|xem)\b/i.test(
        normalized,
      ) &&
      /\b(tin\s*nhắn|tin\s*nhan|messages|chat|lịch\s*sử|lich\s*su)\b/i.test(
        normalized,
      );

    if (wantsThreadMessageDump) {
      const MAX_MESSAGES = 120;
      const MAX_CONTENT_CHARS = 900;
      const assistantMaxChars = 12000;

      const threadMessages = await this.chatService.findByThreadId(
        thread.id,
        MAX_MESSAGES,
      );

      const lines: string[] = [];
      lines.push(`Dưới đây là tin nhắn trong session (thread: ${thread.id}):`);
      lines.push('');

      let total = 0;
      for (let i = 0; i < threadMessages.length; i++) {
        const m = threadMessages[i];
        const role = m.role ?? 'unknown';
        let c = m.content ?? '';
        if (c.length > MAX_CONTENT_CHARS) {
          c = c.slice(0, MAX_CONTENT_CHARS) + '... (bị rút gọn)';
        }
        const line = `${i + 1}. [${role}] ${c}`;
        total += line.length;
        if (total > assistantMaxChars) {
          lines.push('... (đã rút gọn tổng phản hồi)');
          break;
        }
        lines.push(line);
      }

      const response = lines.join('\n');

      await this.chatService.createMessage({
        threadId: thread.id,
        userId: user.uid,
        role: MessageRole.ASSISTANT,
        content: response,
        tokensUsed: 0,
      });

      this.workspaceService.appendSessionEntry(user.identifier, thread.id, {
        type: 'message',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: sanitizeLlmDisplayLeakage(response),
        },
        tokensUsed: 0,
      });

      return {
        response,
        threadId: thread.id,
        tokensUsed: 0,
        runId: `thread-dump-${Date.now()}`,
      };
    }

    if (wantsNewSessionNote) {
      if (user.level !== UserLevel.OWNER) {
        const deniedText = '⛔ Chỉ owner mới có quyền tạo session note file.';
        await this.chatService.createMessage({
          threadId: thread.id,
          userId: user.uid,
          role: MessageRole.ASSISTANT,
          content: deniedText,
          tokensUsed: 0,
        });
        this.workspaceService.appendSessionEntry(user.identifier, thread.id, {
          type: 'message',
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: sanitizeLlmDisplayLeakage(deniedText),
          },
          tokensUsed: 0,
        });
        return {
          response: deniedText,
          threadId: thread.id,
          tokensUsed: 0,
          runId: `session-note-denied-${Date.now()}`,
        };
      }

      // For `/new_session`: only reset thread + persist messages to JSONL.
      // Creating a Markdown `.md` session note file is not required here.
      if (isNewSessionCommand) {
        // Distill nội dung thread đang đóng → MEMORY.md (chạy ngầm trước khi reset)
        this.sessionContextFocusService.scheduleThreadCloseSummary({
          identifier: user.identifier,
          closingThreadId: thread.id,
        });

        // Extract preferences từ thread đang đóng (chạy ngầm)
        this.preferenceExtractor?.scheduleExtraction({
          userId: user.uid,
          threadId: thread.id,
        });

        const jsonPath = this.workspaceService.getThreadFilePath(
          user.identifier,
          thread.id,
        );
        const jsonDisplay = this.workspaceService.userBrainDisplayPath(
          user.identifier,
          jsonPath,
          { isDirectory: false },
        );
        const assistantText = `✅ Đã tạo session mới. Lưu lịch sử tại:\n${jsonDisplay}`;

        await this.chatService.createMessage({
          threadId: thread.id,
          userId: user.uid,
          role: MessageRole.ASSISTANT,
          content: assistantText,
          tokensUsed: 0,
        });

        this.workspaceService.appendSessionEntry(user.identifier, thread.id, {
          type: 'message',
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: sanitizeLlmDisplayLeakage(assistantText),
          },
          tokensUsed: 0,
        });

        return {
          response: assistantText,
          threadId: thread.id,
          tokensUsed: 0,
          runId: `session-note-${Date.now()}`,
        };
      }

      const { filePath } = this.workspaceService.createSessionNoteFile(
        user.identifier,
      );
      this.logger.warn(
        `[GatewayService] Creating session note file: ${filePath}`,
      );

      const noteDisplay = this.workspaceService.userBrainDisplayPath(
        user.identifier,
        filePath,
        { isDirectory: false },
      );
      const assistantText = `✅ Đã tạo session note file mới tại:\n${noteDisplay}`;

      await this.chatService.createMessage({
        threadId: thread.id,
        userId: user.uid,
        role: MessageRole.ASSISTANT,
        content: assistantText,
        tokensUsed: 0,
      });

      this.workspaceService.appendSessionEntry(user.identifier, thread.id, {
        type: 'message',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: sanitizeLlmDisplayLeakage(assistantText),
        },
        tokensUsed: 0,
      });

      return {
        response: assistantText,
        threadId: thread.id,
        tokensUsed: 0,
        runId: `session-note-${Date.now()}`,
      };
    }

    const commandFirst = await this.tryHandleCommandFirst(effectiveContent, {
      userId: user.uid,
      threadId: thread.id,
      actorTelegramId: options?.telegramUserId,
      userIdentifier: user.identifier,
    });
    if (commandFirst.handled) {
      await this.persistAssistantReply(user, thread.id, commandFirst.response, 0);
      return {
        response: commandFirst.response,
        threadId: thread.id,
        tokensUsed: 0,
        runId: `command-first-${Date.now()}`,
      };
    }

    const channelId = options?.channelId || 'webchat';
    const toolHints = this.collectToolHintsFromText(effectiveContent);
    const pipelineContent = this.buildPipelineUserContent(
      effectiveContent,
      toolHints,
    );
    const inboundMessage: IInboundMessage = {
      channelId,
      senderId: user.identifier,
      senderName: user.uname,
      content: pipelineContent,
      mediaUrl: options?.mediaUrl,
      mediaPath: options?.mediaPath ?? pathsFromOpts[0],
      mediaPaths: pathsFromOpts.length ? pathsFromOpts : undefined,
      timestamp: new Date(),
      raw: toolHints.length
        ? { toolHints }
        : undefined,
    };

    const model =
      options?.model ||
      this.configService.get('DEFAULT_MODEL', 'openai/gpt-4o');

    // ─── Per-user concurrency guard ─────────────────────────────────────
    const maxRuns = this.getMaxConcurrentRuns(user.level);
    const currentRuns = this.activeRunsPerUser.get(user.uid) ?? 0;
    if (currentRuns >= maxRuns) {
      const busyMsg =
        `Hệ thống đang xử lý ${currentRuns} tác vụ cho bạn. ` +
        `Vui lòng đợi tác vụ hiện tại hoàn thành rồi gửi lại (tối đa ${maxRuns} tác vụ song song).`;
      await this.persistAssistantReply(user, thread.id, busyMsg, 0);
      return {
        response: busyMsg,
        threadId: thread.id,
        tokensUsed: 0,
        runId: `busy-${user.uid}-${Date.now()}`,
      };
    }
    this.activeRunsPerUser.set(user.uid, currentRuns + 1);
    // ────────────────────────────────────────────────────────────────────

    let pipelineResult: IPipelineContext;
    try {
      pipelineResult = await this.agentService.handleMessage(inboundMessage, {
        userId: user.uid,
        threadId: thread.id,
        actorTelegramId: options?.telegramUserId,
        model,
        skills: toolHints.length ? toolHints : undefined,
      });
    } finally {
      const after = (this.activeRunsPerUser.get(user.uid) ?? 1) - 1;
      if (after <= 0) {
        this.activeRunsPerUser.delete(user.uid);
      } else {
        this.activeRunsPerUser.set(user.uid, after);
      }
    }

    const responseContent = pipelineResult.agentResponse || '';
    if (responseContent) {
      await this.persistAssistantReply(
        user,
        thread.id,
        responseContent,
        pipelineResult.tokensUsed || 0,
      );
    }

    return {
      response: responseContent,
      threadId: thread.id,
      tokensUsed: pipelineResult.tokensUsed || 0,
      runId: pipelineResult.runId,
    };
  }

  async resetThread(
    userId: number,
    platform: ChatPlatform = ChatPlatform.WEB,
  ): Promise<{ threadId: string; message: string }> {
    const { user, thread } = await this.threadResolver.reset(userId, platform);
    return {
      threadId: thread.id,
      message: `Thread reset for ${user.identifier}. New thread: ${thread.id}`,
    };
  }

  async getHistory(userId: number, limit = 50, platform?: ChatPlatform) {
    const { thread } = await this.threadResolver.resolve(
      userId,
      platform ?? ChatPlatform.WEB,
    );
    const messages = await this.chatService.findByThreadId(thread.id, limit);
    return {
      threadId: thread.id,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        tokensUsed: m.tokensUsed,
        createdAt: m.createdAt,
      })),
    };
  }

  getSkills() {
    return this.skillsService.listAllSkills();
  }

  getStatus() {
    return this.agentService.getStatus();
  }

  private resolvePrefExtractInterval(): number {
    const raw = this.configService.get<string>('PREFERENCE_EXTRACT_INTERVAL');
    const n = raw !== undefined && raw !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n < 2) return 5;
    return Math.min(Math.floor(n), 50);
  }
}
