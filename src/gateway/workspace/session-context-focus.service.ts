import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { readFileSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ProvidersService } from '../../agent/providers/providers.service';
import { BackgroundLlmModelService } from '../../agent/pipeline/model-router/background-llm-model.service';
import { ChatService } from '../../modules/chat/chat.service';
import { WorkspaceService } from './workspace.service';
import { MemoryManagerService } from './memory-manager.service';

const FOCUS_FILENAME = 'context_focus.json';
/** File cấp user — xuyên phiên, inject vào mọi thread mới. */
const USER_CONTEXT_FILENAME = 'USER_CONTEXT.md';
const MAX_INPUT_MESSAGES = 36;
const MAX_MSG_CHARS = 1800;
const MAX_OUTPUT_TOKENS = 700;
/** Số lượt assistant giữa 2 lần cập nhật USER_CONTEXT.md cho cùng 1 thread. */
const USER_CONTEXT_UPDATE_INTERVAL = 10;

interface ContextFocusFileV1 {
  version: 1;
  threadId: string;
  updatedAt: string;
  model: string;
  /** Nội dung chèn vào system prompt (tiếng Việt, không emoji). */
  summary: string;
}

/**
 * Phân tích ngữ cảnh nền theo **thread/session** (mỗi user, mỗi thread một file).
 * Chạy **sau** khi assistant đã trả lời và lưu DB — tin user **tiếp theo** nhận thêm khối tóm tắt trong system prompt.
 *
 * Model: `CONTEXT_FOCUS_MODEL` → `DEFAULT_MODEL` → model **CHEAP** đầu tiên resolve được
 * (`BackgroundLlmModelService`). Nếu không có model nào khả dụng → tắt.
 */
@Injectable()
export class SessionContextFocusService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SessionContextFocusService.name);
  private enabled = false;
  private modelId: string | null = null;
  /** Chuỗi job theo thread — tránh chồng chéo cùng session; session khác chạy song song. */
  private readonly chain = new Map<string, Promise<void>>();
  /** Đếm số lượt assistant đã chạy cho mỗi thread trong session runtime này. */
  private readonly turnCount = new Map<string, number>();

  constructor(
    private readonly providersService: ProvidersService,
    private readonly backgroundLlmModel: BackgroundLlmModelService,
    private readonly chatService: ChatService,
    private readonly workspaceService: WorkspaceService,
    @Optional() private readonly memoryManager?: MemoryManagerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const model = await this.backgroundLlmModel.resolveForBackgroundJob();
      if (!model) {
        this.logger.log(
          'Không có model nền khả dụng (CONTEXT_FOCUS_MODEL / DEFAULT_MODEL / CHEAP) — tắt phân tích ngữ cảnh nền.',
        );
        return;
      }
      this.modelId = model;
      this.enabled = true;
      this.logger.log(
        `Session context focus enabled (model=${model}, per-thread file=${FOCUS_FILENAME}).`,
      );
    } catch (e) {
      this.logger.warn(
        `Không khởi tạo session context focus: ${(e as Error).message}`,
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled && !!this.modelId;
  }

  private sanitizeSegment(id: string): string {
    return String(id ?? '')
      .replace(/[^a-zA-Z0-9_.-]/g, '_')
      .slice(0, 96);
  }

  private focusPath(identifier: string, threadId: string): string {
    return path.join(
      this.workspaceService.getUserSessionsDir(identifier),
      this.sanitizeSegment(threadId),
      FOCUS_FILENAME,
    );
  }

  /**
   * Đọc khối nội dung nối vào system prompt (sync I/O trong preprocess).
   */
  readFocusBlockForPrompt(identifier: string, threadId: string): string | null {
    if (!this.isEnabled()) return null;
    try {
      const p = this.focusPath(identifier, threadId);
      const raw = readFileSync(p, 'utf8');
      const j = JSON.parse(raw) as ContextFocusFileV1;
      if (j?.version !== 1 || !j.summary?.trim()) return null;
      return (
        `## Bối cảnh phiên (tóm tắt nền — cập nhật sau lượt assistant trước; ưu tiên tin user **hiện tại** nếu lệch chủ đề)\n` +
        `${j.summary.trim()}`
      );
    } catch {
      return null;
    }
  }

  /**
   * Gọi khi thread cũ kết thúc (ví dụ user gõ /new_session).
   * Distill context_focus.json của thread → ghi vào MEMORY.md section "decisions".
   * Không chờ kết quả (chạy ngầm).
   */
  scheduleThreadCloseSummary(payload: {
    identifier: string;
    closingThreadId: string;
  }): void {
    if (!this.isEnabled() || !this.modelId || !this.memoryManager) return;

    void this.runThreadCloseSummaryJob(payload).catch((e) =>
      this.logger.warn(
        `[thread ${payload.closingThreadId}] Thread-close summary failed: ${(e as Error).message}`,
      ),
    );
  }

  /**
   * Đọc USER_CONTEXT.md của user — inject vào system prompt khi bắt đầu thread mới.
   * Không phụ thuộc CONTEXT_FOCUS_MODEL (chỉ đọc file).
   */
  readUserContextBlock(identifier: string): string | null {
    try {
      const p = path.join(
        this.workspaceService.getUserWorkspaceDir(identifier),
        USER_CONTEXT_FILENAME,
      );
      const raw = readFileSync(p, 'utf-8').trim();
      if (!raw) return null;
      return (
        `## Bối cảnh người dùng (tổng hợp xuyên phiên — cập nhật tự động)\n` +
        raw
      );
    } catch {
      return null;
    }
  }

  /**
   * Sau khi assistant đã persist xong — gọi không await (chạy ngầm). Mỗi `threadId` xếp hàng nối tiếp; thread khác song song.
   */
  scheduleRefreshAfterAssistantMessage(payload: {
    userId: number;
    identifier: string;
    threadId: string;
  }): void {
    if (!this.isEnabled() || !this.modelId) return;

    const { threadId } = payload;
    const count = (this.turnCount.get(threadId) ?? 0) + 1;
    this.turnCount.set(threadId, count);

    const prev = this.chain.get(threadId) ?? Promise.resolve();
    const shouldUpdateUserCtx = count % USER_CONTEXT_UPDATE_INTERVAL === 0;

    const job = prev
      .then(() => this.runRefreshJob(payload))
      .then(() => {
        if (shouldUpdateUserCtx) {
          return this.runUserContextRefreshJob(payload);
        }
      })
      .catch((e) =>
        this.logger.warn(
          `[thread ${threadId}] context focus job: ${(e as Error).message}`,
        ),
      );
    this.chain.set(threadId, job);
    void job.finally(() => {
      if (this.chain.get(threadId) === job) {
        this.chain.delete(threadId);
      }
    });
  }

  private async runRefreshJob(payload: {
    userId: number;
    identifier: string;
    threadId: string;
  }): Promise<void> {
    const { identifier, threadId, userId } = payload;
    const model = this.modelId!;

    const recent = await this.chatService.getRecentMessages(
      threadId,
      MAX_INPUT_MESSAGES,
    );
    const sorted = [...recent].reverse();
    const lines: string[] = [];
    for (const m of sorted) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      let c = (m.content ?? '').replace(/\s+/g, ' ').trim();
      if (c.length > MAX_MSG_CHARS) c = c.slice(0, MAX_MSG_CHARS) + '…';
      lines.push(`[${m.role}]: ${c}`);
    }
    if (lines.length === 0) return;

    const transcript = lines.join('\n');

    const system = `Bạn là bộ phận tóm tắt ngữ cảnh hội thoại (một phiên chat). Nhiệm vụ: đọc transcript theo thời gian (cũ → mới) và viết bản tóm tắt ngắn bằng tiếng Việt cho **lượt assistant tiếp theo**.
Yêu cầu:
- Chủ đề / mục tiêu đang active (ưu tiên phần **cuối** nếu user đổi chủ đề).
- Thực thể quan trọng (tên, file, URL, ID, lệnh, quyết định đã nối).
- Việc đang dở / câu hỏi mở.
- Không emoji, không markdown heading #; có thể dùng gạch đầu dòng ngắn.
- Tối đa khoảng 350 từ. Không bịa nội dung không có trong transcript.`;

    const user = `Transcript:\n${transcript}`;

    const res = await this.providersService.chat({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.25,
      maxTokens: MAX_OUTPUT_TOKENS,
    });

    const summary = (res.content ?? '').trim();
    if (!summary) return;

    const out: ContextFocusFileV1 = {
      version: 1,
      threadId,
      updatedAt: new Date().toISOString(),
      model: res.model ?? model,
      summary,
    };

    const fp = this.focusPath(identifier, threadId);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, JSON.stringify(out, null, 2), 'utf8');

    this.logger.debug(
      `[thread ${threadId}] context_focus.json updated (${summary.length} chars, user=${userId})`,
    );
  }

  /** Distill context_focus của thread đang đóng → append vào MEMORY.md. */
  private async runThreadCloseSummaryJob(payload: {
    identifier: string;
    closingThreadId: string;
  }): Promise<void> {
    const { identifier, closingThreadId } = payload;
    const model = this.modelId!;

    // Đọc context_focus của thread cũ
    let focusSummary = '';
    try {
      const fp = this.focusPath(identifier, closingThreadId);
      const raw = await fs.readFile(fp, 'utf-8').catch(() => '');
      const j = JSON.parse(raw);
      if (j?.summary) focusSummary = j.summary.slice(0, 3000);
    } catch {
      /* không có focus → không đáng persist */
    }

    if (!focusSummary) return;

    const system = `Bạn là công cụ chọn lọc thông tin từ tóm tắt phiên chat.
Nhiệm vụ: đọc tóm tắt phiên và trích xuất những QUYẾT ĐỊNH / HÀNH ĐỘNG / KẾT QUẢ đáng ghi nhớ lâu dài.
Chỉ lấy những gì CỤ THỂ: tên file, URL, lệnh, kết quả, quyết định kỹ thuật, thay đổi cài đặt.
Bỏ qua: hỏi đáp thông thường, thử nghiệm thất bại không kết quả, giải thích lý thuyết.
Format: bullet ngắn, không heading, không emoji. Nếu không có gì đáng lưu → trả về EMPTY.`;

    const res = await this.providersService.chat({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: focusSummary },
      ],
      temperature: 0.2,
      maxTokens: 400,
    });

    const extracted = (res.content ?? '').trim();
    if (!extracted || extracted === 'EMPTY') return;

    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    this.memoryManager!.appendBlock(
      identifier,
      'decisions',
      `<!-- Phiên kết thúc ${now} (thread: ${closingThreadId.slice(0, 8)}) -->\n${extracted}`,
    );

    this.logger.debug(
      `[${identifier}] Thread-close summary persisted to MEMORY.md (${extracted.length} chars).`,
    );
  }

  /**
   * Tạo/cập nhật USER_CONTEXT.md — tóm tắt cấp user xuyên phiên.
   * Đọc MEMORY.md + context_focus hiện tại để distill những gì quan trọng nhất với user này.
   */
  private async runUserContextRefreshJob(payload: {
    userId: number;
    identifier: string;
    threadId: string;
  }): Promise<void> {
    const { identifier, threadId } = payload;
    const model = this.modelId!;

    // Đọc MEMORY.md (tối đa 4000 ký tự phần cuối)
    let memorySnippet = '';
    try {
      const memPath = path.join(
        this.workspaceService.getUserWorkspaceDir(identifier),
        'MEMORY.md',
      );
      const raw = (await fs.readFile(memPath, 'utf-8').catch(() => '')).trim();
      memorySnippet = raw.length > 4000 ? raw.slice(-4000) : raw;
    } catch {
      /* ignore */
    }

    // Đọc context_focus hiện tại của thread
    let focusSnippet = '';
    try {
      const fp = this.focusPath(identifier, threadId);
      const raw = await fs.readFile(fp, 'utf-8').catch(() => '');
      const j = JSON.parse(raw);
      if (j?.summary) focusSnippet = j.summary.slice(0, 2000);
    } catch {
      /* ignore */
    }

    if (!memorySnippet && !focusSnippet) return;

    const sources = [
      memorySnippet ? `## MEMORY.md\n${memorySnippet}` : '',
      focusSnippet ? `## Phiên hiện tại\n${focusSnippet}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const system = `Bạn là công cụ xây dựng "bản tóm tắt người dùng" cho AI agent cá nhân.
Nhiệm vụ: đọc MEMORY.md và ngữ cảnh phiên hiện tại, viết bản tóm tắt súc tích bằng tiếng Việt — dùng để inject vào đầu mọi cuộc hội thoại mới với user này.
Yêu cầu:
- Mục tiêu / dự án dài hạn của user (nếu có).
- Sở thích, phong cách, quy ước xưng hô, ngôn ngữ ưa thích.
- Thực thể thường xuyên xuất hiện (tên, tài khoản, file, công cụ).
- Tuyệt đối không bịa. Nếu không có thông tin thì để trống mục đó.
- Bullet ngắn, không heading #, không emoji. Tối đa 300 từ.`;

    const res = await this.providersService.chat({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: sources },
      ],
      temperature: 0.2,
      maxTokens: 600,
    });

    const summary = (res.content ?? '').trim();
    if (!summary) return;

    const userContextPath = path.join(
      this.workspaceService.getUserWorkspaceDir(identifier),
      USER_CONTEXT_FILENAME,
    );
    await fs.mkdir(path.dirname(userContextPath), { recursive: true });
    await fs.writeFile(
      userContextPath,
      `<!-- Cập nhật: ${new Date().toISOString()} -->\n${summary}`,
      'utf-8',
    );
    this.workspaceService.invalidateSystemContextCache(identifier);

    this.logger.debug(
      `[${identifier}] USER_CONTEXT.md updated (${summary.length} chars)`,
    );
  }
}
