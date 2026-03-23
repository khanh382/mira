import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { ProvidersService } from '../providers/providers.service';
import { BackgroundLlmModelService } from '../pipeline/model-router/background-llm-model.service';
import { WorkspaceService } from '../../gateway/workspace/workspace.service';
import { DEFAULT_BRAIN_DIR } from '../../config/brain-dir.config';

/**
 * Mặc định kích hoạt compaction khi MEMORY.md > 12000 ký tự.
 * Sau compaction, file được rút xuống ~40% (phần tóm tắt) + phần mới nhất.
 * Env: MEMORY_COMPACTION_THRESHOLD_CHARS (mặc định 12000)
 *      MEMORY_COMPACTION_KEEP_TAIL_CHARS  (mặc định 3000 — giữ nguyên N ký tự cuối, không tóm tắt)
 */
const DEFAULT_THRESHOLD_CHARS = 12_000;
const DEFAULT_KEEP_TAIL_CHARS = 3_000;
const MAX_SUMMARY_TOKENS = 800;
const COMPACTION_LOCK_FILE = '.compacting';

@Injectable()
export class MemoryCompactionService {
  private readonly logger = new Logger(MemoryCompactionService.name);
  private readonly brainDir: string;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly providersService?: ProvidersService,
    @Optional() private readonly workspaceService?: WorkspaceService,
    @Optional() private readonly backgroundLlmModel?: BackgroundLlmModelService,
  ) {
    this.brainDir = path.resolve(
      this.configService.get<string>('BRAIN_DIR', DEFAULT_BRAIN_DIR),
    );
  }

  /**
   * Gọi sau khi agent ghi thêm vào MEMORY.md — kiểm tra ngưỡng và compact ngầm nếu cần.
   * Không await ở caller để không block pipeline.
   */
  scheduleCompactionIfNeeded(identifier: string): void {
    const memPath = this.getMemoryPath(identifier);
    if (!fs.existsSync(memPath)) return;

    const threshold = this.resolveInt(
      'MEMORY_COMPACTION_THRESHOLD_CHARS',
      DEFAULT_THRESHOLD_CHARS,
      2000,
      200_000,
    );

    try {
      const size = fs.statSync(memPath).size;
      if (size <= threshold) return;
    } catch {
      return;
    }

    void this.runCompaction(identifier, memPath).catch((e) =>
      this.logger.warn(
        `[${identifier}] MEMORY.md compaction failed: ${(e as Error).message}`,
      ),
    );
  }

  /**
   * Cronjob: compact MEMORY.md cho tất cả users vào 2h sáng (UTC+7).
   * Chỉ compact những file vượt ngưỡng.
   */
  @Cron('0 0 2 * * *', { name: 'memory_compaction', timeZone: 'Asia/Ho_Chi_Minh' })
  async runScheduled(): Promise<void> {
    void this.compactAllUsers().catch((e) =>
      this.logger.error(`Memory compaction scheduled run failed: ${(e as Error).message}`),
    );
  }

  async compactAllUsers(): Promise<void> {
    if (!fs.existsSync(this.brainDir)) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.brainDir, { withFileTypes: true });
    } catch {
      return;
    }

    const threshold = this.resolveInt(
      'MEMORY_COMPACTION_THRESHOLD_CHARS',
      DEFAULT_THRESHOLD_CHARS,
      2000,
      200_000,
    );

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '_shared') continue;
      const identifier = entry.name;
      const memPath = this.getMemoryPath(identifier);
      if (!fs.existsSync(memPath)) continue;

      try {
        const size = fs.statSync(memPath).size;
        if (size > threshold) {
          await this.runCompaction(identifier, memPath);
        }
      } catch (e) {
        this.logger.warn(
          `[${identifier}] Compaction check error: ${(e as Error).message}`,
        );
      }
    }
  }

  private async runCompaction(
    identifier: string,
    memPath: string,
  ): Promise<void> {
    const lockPath = memPath + '.' + COMPACTION_LOCK_FILE;
    if (fs.existsSync(lockPath)) return; // compaction đang chạy

    try {
      fs.writeFileSync(lockPath, new Date().toISOString());
    } catch {
      return;
    }

    try {
      const raw = fs.readFileSync(memPath, 'utf-8');
      const keepTailChars = this.resolveInt(
        'MEMORY_COMPACTION_KEEP_TAIL_CHARS',
        DEFAULT_KEEP_TAIL_CHARS,
        500,
        24_000,
      );

      if (raw.length <= keepTailChars * 2) {
        return; // quá ngắn để compact
      }

      const oldPart = raw.slice(0, raw.length - keepTailChars);
      const freshPart = raw.slice(-keepTailChars);

      const model = await this.resolveModel();
      if (!model) {
        this.logger.debug(
          `[${identifier}] No compaction model available, skip.`,
        );
        return;
      }

      const system = `Bạn là công cụ nén bộ nhớ dài hạn của một AI agent.
Nhiệm vụ: đọc phần MEMORY.md CŨ (có thể dài) và viết lại thành bản **tóm tắt súc tích** bằng tiếng Việt.
Yêu cầu:
- Giữ lại mọi thực thể quan trọng: tên, ID, URL, file, lệnh, quyết định, sở thích user, quy ước.
- Loại bỏ nội dung trùng lặp, dư thừa, quá cũ và không còn liên quan.
- Dùng bullet ngắn, không heading #, không emoji.
- Tối đa ${MAX_SUMMARY_TOKENS * 3} ký tự. Không bịa.`;

      const res = await this.providersService!.chat({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Phần MEMORY.md cần nén:\n\n${oldPart}` },
        ],
        temperature: 0.2,
        maxTokens: MAX_SUMMARY_TOKENS,
      });

      const summary = (res.content ?? '').trim();
      if (!summary) return;

      const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const compacted =
        `<!-- Compacted ${now} -->\n${summary}\n\n` +
        `<!-- Gần đây (giữ nguyên) -->\n${freshPart}`;

      fs.writeFileSync(memPath, compacted, 'utf-8');

      // Invalidate system context cache cho user này
      this.workspaceService?.invalidateSystemContextCache(identifier);

      this.logger.log(
        `[${identifier}] MEMORY.md compacted: ${raw.length} → ${compacted.length} chars`,
      );
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
  }

  private getMemoryPath(identifier: string): string {
    return path.join(
      this.brainDir,
      identifier,
      'workspace',
      'MEMORY.md',
    );
  }

  private async resolveModel(): Promise<string | null> {
    if (!this.providersService) return null;
    try {
      if (this.backgroundLlmModel) {
        return await this.backgroundLlmModel.resolveForBackgroundJob();
      }
    } catch {
      /* no provider ready */
    }
    return null;
  }

  private resolveInt(
    key: string,
    defaultVal: number,
    min: number,
    max: number,
  ): number {
    const raw = this.configService.get<string>(key);
    const n = raw !== undefined && raw !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return defaultVal;
    return Math.min(Math.max(Math.floor(n), min), max);
  }
}
