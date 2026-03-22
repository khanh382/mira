import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ProvidersService } from '../../agent/providers/providers.service';
import { ChatService } from '../../modules/chat/chat.service';
import { WorkspaceService } from './workspace.service';

const FOCUS_FILENAME = 'context_focus.json';
const MAX_INPUT_MESSAGES = 36;
const MAX_MSG_CHARS = 1800;
const MAX_OUTPUT_TOKENS = 700;

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
 * Bật bằng `CONTEXT_FOCUS_MODEL` (phải resolve được qua ProvidersService). Lỗi / không set → tắt hoàn toàn.
 */
@Injectable()
export class SessionContextFocusService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SessionContextFocusService.name);
  private enabled = false;
  private modelId: string | null = null;
  /** Chuỗi job theo thread — tránh chồng chéo cùng session; session khác chạy song song. */
  private readonly chain = new Map<string, Promise<void>>();

  constructor(
    private readonly configService: ConfigService,
    private readonly providersService: ProvidersService,
    private readonly chatService: ChatService,
    private readonly workspaceService: WorkspaceService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const raw = this.configService.get<string>('CONTEXT_FOCUS_MODEL')?.trim();
    if (!raw) {
      this.logger.log(
        'CONTEXT_FOCUS_MODEL không set — bỏ qua phân tích ngữ cảnh nền.',
      );
      return;
    }

    try {
      await this.providersService.ensureProvidersReady();
      if (!this.providersService.canResolveModel(raw)) {
        this.logger.warn(
          `CONTEXT_FOCUS_MODEL="${raw}" không khớp provider nào đã cấu hình — tắt phân tích nền.`,
        );
        return;
      }
      this.modelId = raw;
      this.enabled = true;
      this.logger.log(
        `Session context focus enabled (model=${raw}, per-thread file=${FOCUS_FILENAME}).`,
      );
    } catch (e) {
      this.logger.warn(
        `Không khởi tạo CONTEXT_FOCUS_MODEL (${raw}): ${(e as Error).message} — tắt phân tích nền.`,
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
   * Sau khi assistant đã persist xong — gọi không await (chạy ngầm). Mỗi `threadId` xếp hàng nối tiếp; thread khác song song.
   */
  scheduleRefreshAfterAssistantMessage(payload: {
    userId: number;
    identifier: string;
    threadId: string;
  }): void {
    if (!this.isEnabled() || !this.modelId) return;

    const { threadId } = payload;
    const prev = this.chain.get(threadId) ?? Promise.resolve();
    const job = prev
      .then(() => this.runRefreshJob(payload))
      .catch((e) =>
        this.logger.warn(
          `[thread ${threadId}] context focus job: ${(e as Error).message}`,
        ),
      );
    this.chain.set(threadId, job);
    void job.finally(() => {
      if (this.chain.get(threadId) === job) this.chain.delete(threadId);
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
}
