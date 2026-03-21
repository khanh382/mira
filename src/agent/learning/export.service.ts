import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { ChatService } from '../../modules/chat/chat.service';
import { ChatMessage } from '../../modules/chat/entities/chat-message.entity';
import { DEFAULT_BRAIN_DIR } from '../../config/brain-dir.config';

const BATCH_SIZE = 100;
const MAX_BATCHES_PER_RUN = 50;

/**
 * ExportService — Cronjob "Học để khôn hơn" (Fine-Tune pipeline).
 *
 * 3h sáng mỗi ngày (UTC+7), chạy song song với VectorizationService:
 * 1. Gom chat_messages chưa export (is_exported = false)
 * 2. Nhóm theo user → thread
 * 3. Ghi ra file .jsonl theo format chuẩn fine-tune (OpenAI / Alpaca)
 * 4. Đánh dấu is_exported = true
 *
 * Output: $BRAIN_DIR/_exports/<userId>/YYYY-MM-DD.jsonl
 *
 * File .jsonl có thể dùng trực tiếp cho:
 * - OpenAI fine-tuning API
 * - Huấn luyện model mã nguồn mở (LLaMA, Mistral, Qwen)
 * - Phân tích hành vi user
 */
@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private readonly brainDir: string;
  private running = false;

  constructor(
    private readonly chatService: ChatService,
    private readonly configService: ConfigService,
  ) {
    this.brainDir = path.resolve(
      this.configService.get('BRAIN_DIR', DEFAULT_BRAIN_DIR),
    );
  }

  /**
   * 3h sáng mỗi ngày (UTC+7).
   * Chạy song song với vectorization — mỗi service có lock riêng.
   */
  @Cron('0 0 3 * * *', {
    name: 'export_messages',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async runScheduled(): Promise<void> {
    await this.exportAll();
  }

  async exportAll(): Promise<{ processed: number; files: number }> {
    if (this.running) {
      this.logger.debug('Export already running, skipping');
      return { processed: 0, files: 0 };
    }

    this.running = true;
    let totalProcessed = 0;
    const filesWritten = new Set<string>();

    try {
      for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
        const messages = await this.chatService.findUnexported(BATCH_SIZE);
        if (messages.length === 0) break;

        const grouped = this.groupByUserAndThread(messages);

        for (const [userId, threads] of grouped.entries()) {
          for (const [threadId, msgs] of threads.entries()) {
            const filePath = this.writeJsonl(userId, threadId, msgs);
            filesWritten.add(filePath);
          }
        }

        const ids = messages.map((m) => m.id);
        await this.chatService.markExported(ids);
        totalProcessed += messages.length;

        this.logger.debug(
          `Export batch ${batch + 1}: ${messages.length} messages`,
        );
      }

      if (totalProcessed > 0) {
        this.logger.log(
          `Export complete: ${totalProcessed} messages → ${filesWritten.size} files`,
        );
      }
    } catch (error) {
      this.logger.error(`Export failed: ${error.message}`, error.stack);
    } finally {
      this.running = false;
    }

    return { processed: totalProcessed, files: filesWritten.size };
  }

  // ─── Grouping ─────────────────────────────────────────────

  private groupByUserAndThread(
    messages: ChatMessage[],
  ): Map<number, Map<string, ChatMessage[]>> {
    const result = new Map<number, Map<string, ChatMessage[]>>();

    for (const msg of messages) {
      if (!result.has(msg.userId)) {
        result.set(msg.userId, new Map());
      }
      const threads = result.get(msg.userId)!;
      if (!threads.has(msg.threadId)) {
        threads.set(msg.threadId, []);
      }
      threads.get(msg.threadId)!.push(msg);
    }

    return result;
  }

  // ─── JSONL Writing ────────────────────────────────────────

  /**
   * Ghi messages vào .jsonl file.
   *
   * 2 format:
   * 1. OpenAI fine-tune format (mỗi dòng = 1 conversation turn)
   * 2. Conversation pairs (user→assistant) cho training
   */
  private writeJsonl(
    userId: number,
    threadId: string,
    messages: ChatMessage[],
  ): string {
    const exportDir = this.getExportDir(userId);
    fs.mkdirSync(exportDir, { recursive: true });

    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(exportDir, `${date}.jsonl`);

    const lines: string[] = [];

    // Format 1: Raw messages (append mỗi message)
    for (const msg of messages) {
      lines.push(
        JSON.stringify({
          thread_id: threadId,
          msg_id: msg.id,
          role: msg.role,
          content: msg.content,
          tokens_used: msg.tokensUsed,
          created_at: msg.createdAt.toISOString(),
        }),
      );
    }

    // Format 2: Conversation pairs (user→assistant) cho fine-tune
    const pairs = this.extractConversationPairs(messages);
    for (const pair of pairs) {
      lines.push(
        JSON.stringify({
          _type: 'training_pair',
          thread_id: threadId,
          messages: pair,
        }),
      );
    }

    fs.appendFileSync(filePath, lines.join('\n') + '\n');
    return filePath;
  }

  /**
   * Trích xuất cặp user→assistant liên tiếp cho fine-tuning.
   * Bỏ qua tool messages và system messages.
   *
   * Output format tương thích OpenAI fine-tune:
   * { messages: [{ role: "user", content: "..." }, { role: "assistant", content: "..." }] }
   */
  private extractConversationPairs(
    messages: ChatMessage[],
  ): Array<Array<{ role: string; content: string }>> {
    const pairs: Array<Array<{ role: string; content: string }>> = [];
    const sorted = [...messages].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].role === 'user' && sorted[i + 1].role === 'assistant') {
        pairs.push([
          { role: 'user', content: sorted[i].content },
          { role: 'assistant', content: sorted[i + 1].content },
        ]);
      }
    }

    return pairs;
  }

  // ─── Paths ────────────────────────────────────────────────

  private getExportDir(userId: number): string {
    return path.join(this.brainDir, '_exports', String(userId));
  }

  /**
   * Trả về danh sách file .jsonl đã export cho user.
   */
  getExportFiles(userId: number): string[] {
    const dir = this.getExportDir(userId);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse();
  }
}
