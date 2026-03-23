import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { ProvidersService } from '../providers/providers.service';
import { BackgroundLlmModelService } from '../pipeline/model-router/background-llm-model.service';
import { WorkspaceService } from '../../gateway/workspace/workspace.service';
import { MemoryManagerService } from '../../gateway/workspace/memory-manager.service';
import { DEFAULT_BRAIN_DIR } from '../../config/brain-dir.config';

/**
 * Khi daily note (YYYY-MM-DD.md) của user vượt ngưỡng hoặc là ngày hôm qua,
 * service này dùng LLM để distill các sự kiện quan trọng rồi ghi vào MEMORY.md.
 *
 * Env:
 *  DAILY_NOTE_CONSOLIDATION_THRESHOLD_CHARS (mặc định 4000)
 *  DAILY_NOTE_ARCHIVE (mặc định true) — sau consolidation, daily note được đánh dấu consolidated
 */
const DEFAULT_THRESHOLD_CHARS = 4_000;
const CONSOLIDATED_MARKER = '<!-- consolidated -->';

@Injectable()
export class DailyNotesConsolidationService {
  private readonly logger = new Logger(DailyNotesConsolidationService.name);
  private readonly brainDir: string;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly providersService?: ProvidersService,
    @Optional() private readonly workspaceService?: WorkspaceService,
    @Optional() private readonly memoryManager?: MemoryManagerService,
    @Optional() private readonly backgroundLlmModel?: BackgroundLlmModelService,
  ) {
    this.brainDir = path.resolve(
      this.configService.get<string>('BRAIN_DIR', DEFAULT_BRAIN_DIR),
    );
  }

  /**
   * Gọi sau khi agent ghi thêm vào daily note — kiểm tra ngưỡng và consolidate ngầm nếu cần.
   * Không await ở caller.
   */
  scheduleConsolidationIfNeeded(identifier: string): void {
    const notePath = this.getTodayNotePath(identifier);
    if (!fs.existsSync(notePath)) return;

    const threshold = this.resolveInt(
      'DAILY_NOTE_CONSOLIDATION_THRESHOLD_CHARS',
      DEFAULT_THRESHOLD_CHARS,
      1000,
      100_000,
    );

    try {
      const raw = fs.readFileSync(notePath, 'utf-8');
      if (raw.includes(CONSOLIDATED_MARKER)) return; // đã xử lý rồi
      if (raw.length <= threshold) return;
    } catch {
      return;
    }

    void this.consolidateUser(identifier, notePath).catch((e) =>
      this.logger.warn(
        `[${identifier}] Daily note consolidation failed: ${(e as Error).message}`,
      ),
    );
  }

  /**
   * Cronjob 1h30 sáng: consolidate tất cả daily note của hôm qua cho mọi user.
   * Chạy trước MemoryCompaction (2h) để MEMORY.md đã đầy đủ trước khi compact.
   */
  @Cron('0 30 1 * * *', { name: 'daily_notes_consolidation', timeZone: 'Asia/Ho_Chi_Minh' })
  async runScheduled(): Promise<void> {
    void this.consolidateAllUsers().catch((e) =>
      this.logger.error(`Daily note consolidation scheduled run failed: ${(e as Error).message}`),
    );
  }

  async consolidateAllUsers(): Promise<void> {
    if (!fs.existsSync(this.brainDir)) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.brainDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '_shared') continue;
      try {
        await this.consolidateYesterdayNote(entry.name);
      } catch (e) {
        this.logger.warn(
          `[${entry.name}] Consolidation error: ${(e as Error).message}`,
        );
      }
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async consolidateYesterdayNote(identifier: string): Promise<void> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const notePath = this.getDailyNotePath(identifier, yesterday);
    if (!fs.existsSync(notePath)) return;

    const raw = fs.readFileSync(notePath, 'utf-8');
    if (!raw.trim() || raw.includes(CONSOLIDATED_MARKER)) return;

    await this.consolidateUser(identifier, notePath);
  }

  private async consolidateUser(
    identifier: string,
    notePath: string,
  ): Promise<void> {
    if (!this.providersService || !this.memoryManager) return;

    const model = await this.resolveModel();
    if (!model) {
      this.logger.debug(`[${identifier}] No model for daily consolidation, skip.`);
      return;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(notePath, 'utf-8');
    } catch {
      return;
    }

    if (!raw.trim() || raw.includes(CONSOLIDATED_MARKER)) return;

    const system = `Bạn là công cụ distill sự kiện từ nhật ký hằng ngày của một AI agent cá nhân.
Nhiệm vụ: đọc daily note và trích xuất những THÔNG TIN ĐÁNG GHI NHỚ LÂU DÀI bằng tiếng Việt.
Chỉ lấy:
- Quyết định quan trọng của user (tên project, thay đổi tech stack, URL, file path, tài khoản).
- Sở thích / phong cách / quy tắc user muốn AI tuân theo.
- Task đã hoàn thành có ý nghĩa (kèm kết quả cụ thể, không chung chung).
- Kiến thức / thực thể quan trọng mới phát sinh.
Bỏ qua: hỏi đáp thông thường, lỗi tạm thời đã fix, thông tin trùng, việc vặt.
Format: danh sách bullet ngắn, mỗi bullet 1 dòng, không heading, không emoji. Tối đa 500 từ.
Nếu không có gì đáng ghi → trả về chuỗi rỗng.`;

    const res = await this.providersService.chat({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Daily note:\n\n${raw.slice(0, 8000)}` },
      ],
      temperature: 0.2,
      maxTokens: 700,
    });

    const extracted = (res.content ?? '').trim();

    // Ghi vào MEMORY.md section "Key Facts"
    if (extracted) {
      const dateLabel = path.basename(notePath, '.md');
      this.memoryManager.appendBlock(
        identifier,
        'facts',
        `<!-- Từ daily note ${dateLabel} -->\n${extracted}`,
      );
      this.logger.log(
        `[${identifier}] Daily note ${dateLabel} consolidated into MEMORY.md (${extracted.length} chars).`,
      );
    }

    // Đánh dấu đã xử lý — không xóa file, giữ nguyên để tham khảo
    const archive =
      this.configService.get<string>('DAILY_NOTE_ARCHIVE') !== 'false';
    if (archive) {
      fs.writeFileSync(
        notePath,
        `${CONSOLIDATED_MARKER}\n${raw}`,
        'utf-8',
      );
    }
  }

  private getTodayNotePath(identifier: string): string {
    return this.getDailyNotePath(identifier, new Date());
  }

  private getDailyNotePath(identifier: string, date: Date): string {
    if (!this.workspaceService) return '';
    const filename = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}.md`;
    return path.join(
      this.workspaceService.getUserMemoryDir(identifier),
      filename,
    );
  }

  private async resolveModel(): Promise<string | null> {
    if (!this.providersService) return null;
    try {
      if (this.backgroundLlmModel) {
        return await this.backgroundLlmModel.resolveForBackgroundJob();
      }
    } catch {
      /* no provider */
    }
    return null;
  }

  private resolveInt(key: string, def: number, min: number, max: number): number {
    const raw = this.configService.get<string>(key);
    const n = raw !== undefined && raw !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(Math.floor(n), min), max);
  }
}
