import { Injectable, Logger } from '@nestjs/common';
import { WorkspaceService } from '../../../../gateway/workspace/workspace.service';
import { UsersService } from '../../../../modules/users/users.service';

const TRACKER_FILE = 'GOOGLE_DRIVE.md';

interface TrackedResource {
  id: string;
  name: string;
  type: 'spreadsheet' | 'document' | 'folder' | 'presentation' | 'file';
  url?: string;
  parentId?: string;
  parentName?: string;
  sheets?: string[];
  createdAt: string;
  updatedAt: string;
}

interface DriveState {
  resources: TrackedResource[];
  deleted: Array<{
    id: string;
    name: string;
    type: string;
    deletedAt: string;
  }>;
}

/**
 * DriveTrackerService — tự động ghi nhớ trạng thái Google Drive per-user.
 *
 * Lưu file GOOGLE_DRIVE.md trong workspace:
 *   heart/<identifier>/workspace/GOOGLE_DRIVE.md
 *
 * Được WorkspaceService.buildAgentSystemContext() đọc tự động
 * → agent luôn biết danh sách file/folder/sheet đang có & đã xóa.
 */
@Injectable()
export class DriveTrackerService {
  private readonly logger = new Logger(DriveTrackerService.name);

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Phân tích kết quả từ google_workspace skill
   * và tự động cập nhật GOOGLE_DRIVE.md nếu detect thay đổi.
   */
  async trackOperation(
    userId: number,
    service: string,
    action: string,
    result: unknown,
    success: boolean,
  ): Promise<void> {
    if (!success) return;

    try {
      const user = await this.usersService.findById(userId);
      if (!user) return;

      const op = this.detectOperation(service, action);
      if (!op) return;

      const state = this.loadState(user.identifier);

      switch (op.type) {
        case 'create':
          this.handleCreate(state, service, op, result);
          break;
        case 'update':
          this.handleUpdate(state, service, op, result);
          break;
        case 'delete':
          this.handleDelete(state, op, result);
          break;
        case 'rename':
          this.handleRename(state, op, result);
          break;
      }

      this.saveState(user.identifier, state);
    } catch (error) {
      this.logger.warn(`DriveTracker failed: ${error.message}`);
    }
  }

  // ─── Operation Detection ──────────────────────────────────

  private detectOperation(
    service: string,
    action: string,
  ): { type: 'create' | 'update' | 'delete' | 'rename'; verb: string; args: string[] } | null {
    const parts = action.trim().split(/\s+/);
    const verb = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    if (service === 'sheets') {
      if (verb === 'create') return { type: 'create', verb, args };
      if (verb === 'update' || verb === 'append') return { type: 'update', verb, args };
      if (verb === 'delete') return { type: 'delete', verb, args };
    }

    if (service === 'docs') {
      if (verb === 'create') return { type: 'create', verb, args };
      if (verb === 'delete') return { type: 'delete', verb, args };
    }

    if (service === 'slides') {
      if (verb === 'create') return { type: 'create', verb, args };
      if (verb === 'delete') return { type: 'delete', verb, args };
    }

    if (service === 'drive') {
      if (verb === 'mkdir' || verb === 'create') return { type: 'create', verb, args };
      if (verb === 'upload') return { type: 'create', verb, args };
      if (verb === 'rm' || verb === 'delete' || verb === 'trash') return { type: 'delete', verb, args };
      if (verb === 'mv' || verb === 'rename') return { type: 'rename', verb, args };
    }

    return null;
  }

  // ─── Handlers ─────────────────────────────────────────────

  private handleCreate(
    state: DriveState,
    service: string,
    op: { verb: string; args: string[] },
    result: unknown,
  ): void {
    const data = result as Record<string, any>;
    const now = new Date().toISOString();

    const typeMap: Record<string, TrackedResource['type']> = {
      sheets: 'spreadsheet',
      docs: 'document',
      slides: 'presentation',
      drive: op.verb === 'mkdir' ? 'folder' : 'file',
    };

    const id = this.extractId(data);
    const name = this.extractName(data, op.args);
    if (!id && !name) return;

    const existing = id ? state.resources.find((r) => r.id === id) : null;
    if (existing) {
      existing.updatedAt = now;
      existing.name = name || existing.name;
      return;
    }

    const resource: TrackedResource = {
      id: id || `unknown_${Date.now()}`,
      name: name || 'Untitled',
      type: typeMap[service] || 'file',
      url: this.buildUrl(id, service),
      createdAt: now,
      updatedAt: now,
    };

    if (service === 'sheets' && data?.sheets) {
      resource.sheets = this.extractSheetNames(data.sheets);
    }

    if (data?.parents?.[0]) {
      resource.parentId = data.parents[0];
    }

    // Remove from deleted list if re-created
    state.deleted = state.deleted.filter((d) => d.id !== resource.id);

    state.resources.push(resource);
    this.logger.debug(`Tracked new ${resource.type}: "${resource.name}" (${resource.id})`);
  }

  private handleUpdate(
    state: DriveState,
    service: string,
    op: { verb: string; args: string[] },
    result: unknown,
  ): void {
    const targetId = op.args[0];
    if (!targetId) return;

    const resource = state.resources.find((r) => r.id === targetId);
    if (resource) {
      resource.updatedAt = new Date().toISOString();

      const data = result as Record<string, any>;
      if (service === 'sheets' && data?.sheets) {
        resource.sheets = this.extractSheetNames(data.sheets);
      }
    }
  }

  private handleDelete(
    state: DriveState,
    op: { verb: string; args: string[] },
    _result: unknown,
  ): void {
    const targetId = op.args[0];
    if (!targetId) return;

    const idx = state.resources.findIndex((r) => r.id === targetId);
    if (idx >= 0) {
      const removed = state.resources.splice(idx, 1)[0];
      state.deleted.push({
        id: removed.id,
        name: removed.name,
        type: removed.type,
        deletedAt: new Date().toISOString(),
      });
      this.logger.debug(`Tracked deletion: "${removed.name}" (${removed.id})`);
    } else {
      state.deleted.push({
        id: targetId,
        name: 'Unknown',
        type: 'file',
        deletedAt: new Date().toISOString(),
      });
    }
  }

  private handleRename(
    state: DriveState,
    op: { verb: string; args: string[] },
    result: unknown,
  ): void {
    const targetId = op.args[0];
    const data = result as Record<string, any>;
    const newName = data?.name || op.args[1];
    if (!targetId) return;

    const resource = state.resources.find((r) => r.id === targetId);
    if (resource && newName) {
      resource.name = newName;
      resource.updatedAt = new Date().toISOString();
    }
  }

  // ─── State Persistence (Markdown) ────────────────────────

  private loadState(identifier: string): DriveState {
    const content = this.workspaceService.readWorkspaceFile(identifier, TRACKER_FILE);
    if (!content) return { resources: [], deleted: [] };

    try {
      const jsonMatch = content.match(/<!--\s*STATE_JSON\s*([\s\S]*?)\s*-->/);
      if (jsonMatch?.[1]) {
        return JSON.parse(jsonMatch[1]);
      }
    } catch {
      // corrupt state, rebuild from scratch
    }

    return { resources: [], deleted: [] };
  }

  private saveState(identifier: string, state: DriveState): void {
    const md = this.renderMarkdown(state);
    this.workspaceService.writeWorkspaceFile(identifier, TRACKER_FILE, md);
  }

  private renderMarkdown(state: DriveState): string {
    const lines: string[] = ['# Google Drive — Tracked Resources\n'];

    if (state.resources.length > 0) {
      const groups = this.groupByType(state.resources);

      for (const [type, items] of Object.entries(groups)) {
        lines.push(`## ${this.typeLabel(type)} (${items.length})\n`);

        for (const item of items) {
          const url = item.url ? ` — [Open](${item.url})` : '';
          const parent = item.parentName
            ? ` (in: ${item.parentName})`
            : item.parentId
              ? ` (folder: ${item.parentId})`
              : '';
          lines.push(`- **${item.name}** \`${item.id}\`${parent}${url}`);

          if (item.sheets?.length) {
            lines.push(`  - Sheets: ${item.sheets.join(', ')}`);
          }

          lines.push(`  - Updated: ${item.updatedAt.slice(0, 16).replace('T', ' ')}`);
        }
        lines.push('');
      }
    } else {
      lines.push('_No tracked resources yet._\n');
    }

    if (state.deleted.length > 0) {
      lines.push(`## Deleted (${state.deleted.length})\n`);
      lines.push('> These items have been deleted. Do not reference them.\n');
      for (const item of state.deleted.slice(-20)) {
        lines.push(
          `- ~~${item.name}~~ \`${item.id}\` (${item.type}) — deleted ${item.deletedAt.slice(0, 16).replace('T', ' ')}`,
        );
      }
      lines.push('');
    }

    lines.push(`<!-- STATE_JSON\n${JSON.stringify(state)}\n-->`);

    return lines.join('\n');
  }

  // ─── Helpers ──────────────────────────────────────────────

  private extractId(data: Record<string, any>): string | null {
    return (
      data?.spreadsheetId ||
      data?.documentId ||
      data?.presentationId ||
      data?.id ||
      data?.fileId ||
      null
    );
  }

  private extractName(data: Record<string, any>, args: string[]): string | null {
    if (data?.properties?.title) return data.properties.title;
    if (data?.title) return data.title;
    if (data?.name) return data.name;
    if (args.length > 0) {
      const candidate = args.join(' ').replace(/^['"]|['"]$/g, '');
      if (candidate && !candidate.startsWith('-')) return candidate;
    }
    return null;
  }

  private extractSheetNames(sheets: any[]): string[] {
    if (!Array.isArray(sheets)) return [];
    return sheets
      .map((s) => s?.properties?.title || s?.title || s?.name)
      .filter(Boolean);
  }

  private buildUrl(id: string | null, service: string): string | undefined {
    if (!id) return undefined;
    const urlMap: Record<string, string> = {
      sheets: `https://docs.google.com/spreadsheets/d/${id}`,
      docs: `https://docs.google.com/document/d/${id}`,
      slides: `https://docs.google.com/presentation/d/${id}`,
      drive: `https://drive.google.com/file/d/${id}`,
    };
    return urlMap[service];
  }

  private groupByType(
    resources: TrackedResource[],
  ): Record<string, TrackedResource[]> {
    const groups: Record<string, TrackedResource[]> = {};
    for (const r of resources) {
      if (!groups[r.type]) groups[r.type] = [];
      groups[r.type].push(r);
    }
    return groups;
  }

  private typeLabel(type: string): string {
    const labels: Record<string, string> = {
      spreadsheet: 'Spreadsheets',
      document: 'Documents',
      folder: 'Folders',
      presentation: 'Presentations',
      file: 'Files',
    };
    return labels[type] || 'Other';
  }
}
