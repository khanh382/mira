import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceService } from './workspace.service';

/**
 * Các section được nhận diện trong MEMORY.md.
 * Mỗi section là một heading `## <tên>`.
 */
export type MemorySection =
  | 'projects'
  | 'preferences'
  | 'facts'
  | 'decisions'
  | 'misc';

const SECTION_HEADINGS: Record<MemorySection, string> = {
  projects: '## Projects',
  preferences: '## Preferences',
  facts: '## Key Facts',
  decisions: '## Recent Decisions',
  misc: '## Notes',
};

/**
 * Facade cho MEMORY.md — đọc / ghi theo section.
 *
 * Cấu trúc MEMORY.md chuẩn hoá thành:
 * ```
 * ## Projects
 * - ...
 *
 * ## Preferences
 * - ...
 *
 * ## Key Facts
 * - ...
 *
 * ## Recent Decisions
 * - ...
 *
 * ## Notes
 * - ...
 * ```
 */
@Injectable()
export class MemoryManagerService {
  private readonly logger = new Logger(MemoryManagerService.name);

  constructor(private readonly workspaceService: WorkspaceService) {}

  /** Đọc toàn bộ MEMORY.md. Trả về '' nếu chưa có file. */
  read(identifier: string): string {
    const p = this.memoryPath(identifier);
    try {
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
    } catch {
      return '';
    }
  }

  /** Ghi đè toàn bộ MEMORY.md. */
  write(identifier: string, content: string): void {
    const p = this.memoryPath(identifier);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
    this.workspaceService.invalidateSystemContextCache(identifier);
  }

  /**
   * Append một dòng bullet vào section chỉ định (tạo section nếu chưa có).
   * Timestamp được đặt trước bullet để dễ tra cứu.
   */
  appendBullet(
    identifier: string,
    section: MemorySection,
    bullet: string,
  ): void {
    const raw = this.read(identifier);
    const heading = SECTION_HEADINGS[section];
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const line = `- [${timestamp}] ${bullet.trim()}`;

    const updated = this.insertIntoSection(raw, heading, line);
    this.write(identifier, updated);
    this.logger.debug(`[${identifier}] MemoryManager appended to ${section}.`);
  }

  /**
   * Append một block văn bản tự do (đã được LLM định dạng sẵn) vào section.
   * Dùng khi nội dung là nhiều dòng (ví dụ: tóm tắt phiên).
   */
  appendBlock(
    identifier: string,
    section: MemorySection,
    block: string,
  ): void {
    const raw = this.read(identifier);
    const heading = SECTION_HEADINGS[section];
    const updated = this.insertIntoSection(raw, heading, block.trim());
    this.write(identifier, updated);
  }

  /** Đọc nội dung một section cụ thể. Trả về '' nếu không tìm thấy. */
  readSection(identifier: string, section: MemorySection): string {
    const raw = this.read(identifier);
    return this.extractSection(raw, SECTION_HEADINGS[section]);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private memoryPath(identifier: string): string {
    return path.join(
      this.workspaceService.getUserWorkspaceDir(identifier),
      'MEMORY.md',
    );
  }

  /**
   * Chèn `content` vào cuối section `heading` trong `raw`.
   * Nếu section chưa tồn tại → tạo mới ở cuối file.
   */
  private insertIntoSection(
    raw: string,
    heading: string,
    content: string,
  ): string {
    const headingPattern = new RegExp(
      `^${escapeRegex(heading)}\\s*$`,
      'm',
    );

    if (headingPattern.test(raw)) {
      // Tìm vị trí heading, chèn nội dung sau block hiện tại của section
      const lines = raw.split('\n');
      const headingIdx = lines.findIndex((l) =>
        l.trim() === heading.trim(),
      );
      if (headingIdx < 0) return raw + '\n\n' + heading + '\n' + content;

      // Tìm heading tiếp theo hoặc cuối file
      let insertIdx = lines.length;
      for (let i = headingIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith('## ')) {
          insertIdx = i;
          break;
        }
      }

      // Loại bỏ trailing blank lines trước heading tiếp
      while (insertIdx > headingIdx + 1 && lines[insertIdx - 1].trim() === '') {
        insertIdx--;
      }

      lines.splice(insertIdx, 0, content, '');
      return lines.join('\n');
    }

    // Section chưa có → thêm vào cuối
    const tail = raw.trimEnd();
    return tail + (tail ? '\n\n' : '') + heading + '\n' + content + '\n';
  }

  /** Trích xuất nội dung của 1 section (từ heading đến heading tiếp theo). */
  private extractSection(raw: string, heading: string): string {
    const lines = raw.split('\n');
    const startIdx = lines.findIndex((l) => l.trim() === heading.trim());
    if (startIdx < 0) return '';

    const parts: string[] = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) break;
      parts.push(lines[i]);
    }
    return parts.join('\n').trim();
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
