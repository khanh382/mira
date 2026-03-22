import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HooksService } from '../../hooks/hooks.service';
import {
  InternalHookEvent,
  PluginHookName,
} from '../../hooks/enums/hook-events.enum';
import {
  IPipelineContext,
  PipelineStage,
} from '../interfaces/pipeline-context.interface';
import { ILlmMessage } from '../../providers/interfaces/llm-provider.interface';
import { ChatService } from '../../../modules/chat/chat.service';
import { UsersService } from '../../../modules/users/users.service';
import { WorkspaceService } from '../../../gateway/workspace/workspace.service';
import { SessionContextFocusService } from '../../../gateway/workspace/session-context-focus.service';

const DEFAULT_HISTORY_LIMIT = 30;
const MAX_HISTORY_LIMIT_CAP = 120;
const MIN_CURRENT_TOKENS_FOR_PRUNE = 3;
// Similarity heuristic: if the current message shares too few keywords with
// recent turns (user + assistant), we treat it as a "new topic" turn.
// Higher threshold => prune more aggressively when topic likely changed.
const TOPIC_JACCARD_THRESHOLD = 0.1;
/** Số tin user+assistant gần nhất dùng để tính overlap (tránh chỉ so với 1 tin user). */
const TOPIC_OVERLAP_RECENT_MESSAGES = 10;

@Injectable()
export class PreprocessStep {
  private readonly logger = new Logger(PreprocessStep.name);

  constructor(
    private readonly hooksService: HooksService,
    private readonly chatService: ChatService,
    private readonly usersService: UsersService,
    private readonly workspaceService: WorkspaceService,
    private readonly configService: ConfigService,
    private readonly sessionContextFocusService: SessionContextFocusService,
  ) {}

  async execute(context: IPipelineContext): Promise<IPipelineContext> {
    this.logger.debug(`[${context.runId}] Preprocessing message`);

    // ─── 1. Load system context from workspace files ──────
    await this.loadSystemContext(context);

    // ─── 2. Load recent conversation history from DB ──────
    await this.loadConversationHistory(context);

    await this.appendSessionFocusToSystemContext(context);

    // Gợi ý tool khi có file đính kèm (đường dẫn thường đã nằm trong content từ gateway)
    const hasLocalMedia =
      Boolean(context.mediaPath) ||
      Boolean(context.mediaUrl) ||
      (context.mediaPaths?.length ?? 0) > 0;
    if (hasLocalMedia) {
      const explicitWebSearch =
        /\/web_search\b/i.test(context.processedContent) ||
        /\/tool_web_search\b/i.test(context.processedContent);
      const hint = explicitWebSearch
        ? '\n\n[Hệ thống] Có file đính kèm nhưng user đã gõ `/web_search` — chỉ gọi tool `web_search` với `query` lấy từ **phần chữ** của tin (vd. triệu chứng / câu hỏi). ' +
          'Không gọi `image_understand` trừ khi vision đã hoạt động; ảnh không gửi được vào Google/Brave như query.'
        : '\n\n[Hệ thống] Có file/URL đính kèm — khi cần hãy gọi tool thật: ' +
          '`pdf_read` cho PDF, `image_understand` cho ảnh (khi vision đã bật), ' +
          '`file_read` cho json/txt/md/csv/log theo đường dẫn tuyệt đối trên server, ' +
          'hoặc `exec` để xử lý file khi phù hợp; không bịa kết quả đọc file.';
      if (
        !context.processedContent.includes('[Hệ thống] Có file/URL đính kèm') &&
        !context.processedContent.includes(
          '[Hệ thống] Có file đính kèm nhưng user đã gõ',
        )
      ) {
        context.processedContent += hint;
      }
    }

    // ─── 3. Media transcription hook ──────────────────────
    if (hasLocalMedia) {
      await this.hooksService.emitInternal(
        InternalHookEvent.MESSAGE_TRANSCRIBED,
        {
          sessionKey: `thread:${context.threadId}`,
          context: { transcript: context.transcript },
        },
      );
    }

    // ─── 4. Plugin hook: BEFORE_PROMPT_BUILD ──────────────
    const preprocessed = await this.hooksService.executePluginHook(
      PluginHookName.BEFORE_PROMPT_BUILD,
      {
        content: context.processedContent,
        transcript: context.transcript,
        userId: context.userId,
        threadId: context.threadId,
      },
    );

    context.processedContent = preprocessed.content ?? context.processedContent;

    await this.hooksService.emitInternal(
      InternalHookEvent.MESSAGE_PREPROCESSED,
      {
        sessionKey: `thread:${context.threadId}`,
        context: { content: context.processedContent },
      },
    );

    context.stage = PipelineStage.PREPROCESSED;
    return context;
  }

  /**
   * Đọc SOUL.md, USER.md, AGENTS.md, MEMORY.md, daily memory
   * từ workspace files → inject làm system message đầu tiên.
   */
  private async loadSystemContext(context: IPipelineContext): Promise<void> {
    try {
      const user = await this.usersService.findById(context.userId);
      if (!user) return;

      const systemContext = this.workspaceService.buildAgentSystemContext(
        user.identifier,
      );

      if (systemContext) {
        context.conversationHistory.unshift({
          role: 'system',
          content: systemContext,
        });

        this.logger.debug(
          `[${context.runId}] System context loaded (${systemContext.length} chars)`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `[${context.runId}] Failed to load system context: ${error.message}`,
      );
    }
  }

  /**
   * Load N tin nhắn gần nhất từ DB (chat_messages) → conversationHistory.
   * Giúp agent nhớ context từ các lượt chat trước trong cùng thread.
   */
  private async loadConversationHistory(
    context: IPipelineContext,
  ): Promise<void> {
    try {
      const historyLimit = this.resolveHistoryLimit();
      const recentMessages = await this.chatService.getRecentMessages(
        context.threadId,
        historyLimit,
      );

      if (recentMessages.length === 0) return;

      const sorted = recentMessages.reverse();

      const historyMessages: ILlmMessage[] = sorted
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      context.conversationHistory.push(...historyMessages);

      // Topic relevance pruning:
      // When a new message is unrelated to the recent topic, we shouldn't inject
      // the full last-N history; otherwise the model may "drift" and repeat
      // old content from conversationHistory.
      this.maybePruneIrrelevantHistory(context, historyMessages);

      this.logger.debug(
        `[${context.runId}] Loaded ${historyMessages.length} history messages (limit=${historyLimit}) from thread ${context.threadId}`,
      );
    } catch (error) {
      this.logger.warn(
        `[${context.runId}] Failed to load conversation history: ${error.message}`,
      );
    }
  }

  /**
   * Nối tóm tắt nền theo session (file `sessions/<thread>/context_focus.json`) vào system prompt đầu tiên.
   */
  private async appendSessionFocusToSystemContext(
    context: IPipelineContext,
  ): Promise<void> {
    if (!this.sessionContextFocusService.isEnabled()) return;
    try {
      const user = await this.usersService.findById(context.userId);
      if (!user?.identifier) return;
      const block = this.sessionContextFocusService.readFocusBlockForPrompt(
        user.identifier,
        context.threadId,
      );
      if (!block) return;
      const first = context.conversationHistory[0];
      if (first?.role !== 'system' || !first.content) return;
      first.content = `${first.content}\n\n${block}`;
    } catch (e) {
      this.logger.debug(
        `[${context.runId}] Session focus append skipped: ${(e as Error).message}`,
      );
    }
  }

  /** Số tin nhắn gần nhất load từ DB (user+assistant). Env: CHAT_HISTORY_LIMIT */
  private resolveHistoryLimit(): number {
    const raw = this.configService.get<string>('CHAT_HISTORY_LIMIT');
    const n = raw !== undefined && raw !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n < 1) return DEFAULT_HISTORY_LIMIT;
    return Math.min(Math.floor(n), MAX_HISTORY_LIMIT_CAP);
  }

  private maybePruneIrrelevantHistory(
    context: IPipelineContext,
    historyMessages: ILlmMessage[],
  ): void {
    const current = context.processedContent ?? '';
    const currentTokens = this.tokenizeKeywords(current);

    // If current turn explicitly involves web/browser/weather continuation,
    // don't prune history; we want the model to see the weather topic it
    // is continuing from.
    if (
      /(\bbrowser\b|\btrình\s*duyệt\b|\btrinh\s*duyet\b|\bsearch\b|\btìm\s*kiếm\b|\bthời\s*tiết\b|\bthoi\s*tiet\b|\bdự\s*báo\b|\bdu\s*bao\b|\bweather\b|\bforecast\b)/i.test(
        current,
      )
    ) {
      return;
    }

    // Strong intent: user asks to dump "all messages" of this session.
    // In this turn, we should not mix old history because it can trigger
    // unrelated tool-based behavior.
    const isSessionDumpRequest =
      /\b(session|phiên|phien)\b/i.test(current) &&
      /\b(toàn\s*bộ|toan\s*bo|tất\s*cả|tat\s*ca|liệt\s*kê|liet\s*ke|xem)\b/i.test(
        current,
      ) &&
      /\b(tin\s*nhắn|tin\s*nhan|messages|chat|lịch\s*sử|lich\s*su)\b/i.test(
        current,
      );
    if (isSessionDumpRequest) {
      context.conversationHistory = context.conversationHistory.filter(
        (m) => m.role === 'system',
      );
      this.logger.debug(`[${context.runId}] Pruned history for session-dump intent`);
      return;
    }

    // Don't prune if the current message looks like a short confirmation
    // (e.g. "đồng ý xóa") — those often rely on conversation history.
    const looksLikeConfirmation =
      /^(?:\/)?(đồng\s*ý|ok|được|xác\s*nhận|confirm)\b/i.test(current.trim()) ||
      /\b(xóa|xoa|delete|remove|rm|trash|thùng\s*rác|thung\s*rac)\b/i.test(
        current,
      );
    if (looksLikeConfirmation) return;

    // Câu tiếp theo ngắn / đại từ / "thế sao" — gần như luôn bám ngữ cảnh lượt trước;
    // so Jaccard với *một* tin user dài trước đó hay cho điểm ~0 → đừng prune.
    if (this.looksLikeFollowUpTurn(current)) return;

    const hasContinuation =
      /\b(như\s*trên|nhu\s*tren|tiếp\s*tục|tiep\s*tuc|tiếp\s*theo|tiep\s*theo|vẫn|van|làm\s*tiếp|lam\s*tiep|gửi\s*tiếp|gui\s*tiep|tiếp\s*nhé|tiep\s*nhe|theo\s*đó|theo\s*do)\b/i.test(
        current,
      );

    if (currentTokens.length < MIN_CURRENT_TOKENS_FOR_PRUNE) return;

    const score = this.maxTopicOverlapWithRecent(
      current,
      historyMessages,
      TOPIC_OVERLAP_RECENT_MESSAGES,
    );

    // Common case: structured "Chủ đề: ... Nội dung: ..." email prompts.
    const structuredNewPrompt =
      /\b(chủ\s*đề\s*:|chu\s*de\s*:|nội\s*dung\s*:|noi\s*dung\s*:)\b/i.test(
        current,
      );

    // If current is a structured new prompt and shares little with the last user message,
    // prune history aggressively.
    const shouldPrune = structuredNewPrompt
      ? score < TOPIC_JACCARD_THRESHOLD * 1.5
      : score < TOPIC_JACCARD_THRESHOLD;

    if (!shouldPrune) return;

    // If user uses continuation cues, don't drop all history.
    // Keep a small trailing window to preserve "continuing the last task"
    // while still removing older unrelated topic drift.
    const systemMessages = context.conversationHistory.filter(
      (m) => m.role === 'system',
    );
    const nonSystemMessages = context.conversationHistory.filter(
      (m) => m.role !== 'system',
    );
    const keepCount = hasContinuation ? 4 : 0;
    const keptTail = keepCount > 0 ? nonSystemMessages.slice(-keepCount) : [];

    context.conversationHistory = [...systemMessages, ...keptTail];
    this.logger.debug(
      `[${context.runId}] Pruned irrelevant history (jaccard=${score.toFixed(3)}; currentTokens=${currentTokens.length}; hasContinuation=${hasContinuation}; keepNonSystem=${keptTail.length})`,
    );
  }

  /**
   * Tin ngắn / hỏi tiếp ("thế sao?", "còn X?") — Jaccard với một tin user dài trước đó thường ~0
   * dù vẫn cùng chủ đề; không prune. Tin dài, không khớp mẫu → dùng maxTopicOverlapWithRecent.
   */
  private looksLikeFollowUpTurn(text: string): boolean {
    const t = String(text ?? '').trim();
    if (!t) return false;
    const wc = t.split(/\s+/).length;
    if (wc <= 8 || t.length <= 56) return true;
    const n = t
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();
    return (
      /^(the|va|ua|con|vay|sao|gi|roi)\b/i.test(n) ||
      /\b(the\s+thi|vay\s+thi|con\s+(ve|lai)|nhu\s+vay|noi\s+tiep|y\s+tren|cai\s+do|phan\s+tren|cau\s+tren|tin\s+tren)\b/i.test(
        n,
      ) ||
      /\b(what\s+about|how\s+about)\b/i.test(n)
    );
  }

  /** Lấy max Jaccard giữa tin hiện tại và N tin user/assistant cuối (kể cả bản assistant vừa trả lời). */
  private maxTopicOverlapWithRecent(
    current: string,
    historyMessages: ILlmMessage[],
    depth: number,
  ): number {
    const tail = historyMessages.slice(-Math.max(1, depth));
    let max = 0;
    for (const m of tail) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const c = m.content ?? '';
      if (!c.trim()) continue;
      const s = this.topicJaccard(current, c);
      if (s > max) max = s;
    }
    return max;
  }

  private tokenizeKeywords(text: string): string[] {
    const normalized = this.normalizeText(text);
    const raw = normalized
      .split(/[^a-z0-9_]+/i)
      .map((s) => s.trim())
      .filter(Boolean);

    // Minimal stopword list (Vietnamese + English) to avoid false overlap.
    const stop = new Set([
      'va',
      'la',
      'cua',
      'de',
      'duoc',
      'voi',
      'tren',
      'duoi',
      'trong',
      'ngoai',
      'nhung',
      'mot',
      'nhieu',
      'va',
      'va',
      'toi',
      'ban',
      'em',
      'anh',
      'se',
      'seu',
      'the',
      'that',
      'this',
      'with',
      'from',
      'for',
      'and',
      'or',
      'to',
      'in',
      'on',
      'at',
      'is',
      'are',
      'as',
      'an',
      'a',
      'the',
      'khi',
      'nen',
      'se',
      'se',
      'hop',
    ]);

    return raw
      .filter((t) => t.length >= 3 && !stop.has(t))
      .slice(0, 120);
  }

  private topicJaccard(a: string, b: string): number {
    const A = new Set(this.tokenizeKeywords(a));
    const B = new Set(this.tokenizeKeywords(b));
    if (A.size === 0 || B.size === 0) return 0;

    let inter = 0;
    for (const w of A) {
      if (B.has(w)) inter++;
    }

    const union = A.size + B.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  private normalizeText(text: string): string {
    return (text ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
