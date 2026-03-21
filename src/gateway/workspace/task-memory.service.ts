import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { WorkspaceService } from './workspace.service';
import { UsersService } from '../../modules/users/users.service';
import { IntentType } from '../../agent/pipeline/model-router/model-tier.enum';

const INDEX_FILENAME = '_tasks_index.json';
const STATE_FILENAME = 'state.json';

/** Sau số lần lượt chạy tool lỗi liên tiếp này mới được hỏi user chọn hướng (trước đó: tự gọi tool). */
export const TASK_MEMORY_ASK_USER_AFTER_FAILED_STREAK = 50;

export type TaskMemoryStatus = 'open' | 'done' | 'cancelled';

export interface TaskMemoryCheckpoint {
  runId: string;
  at: string;
  summary: string;
}

export interface TaskMemoryState {
  taskId: string;
  ordinal: number;
  threadId: string;
  status: TaskMemoryStatus;
  createdAt: string;
  updatedAt: string;
  sourceUserMessagePreview: string;
  notes: string;
  checkpoints: TaskMemoryCheckpoint[];
  /**
   * Tích lũy số lần gọi tool trả success=false; reset về 0 khi trong một lượt pipeline mọi tool đều success=true.
   * So với TASK_MEMORY_ASK_USER_AFTER_FAILED_STREAK để hạn chế hỏi user trước khi thử đủ.
   */
  failedRunStreak?: number;
}

interface TasksIndexFile {
  version: 1;
  threadId: string;
  updatedAt: string;
  tasks: Array<{
    taskId: string;
    ordinal: number;
    status: TaskMemoryStatus;
    createdAt: string;
    updatedAt: string;
    sourcePreview: string;
  }>;
}

/**
 * Bộ nhớ tác vụ theo phiên (thread): mỗi tác vụ phức tạp từ một tin user có chỉ mục riêng,
 * lưu dưới $BRAIN_DIR/<identifier>/sessions/<thread>/tasks/ — không chồng chéo giữa các task.
 */
@Injectable()
export class TaskMemoryService {
  private readonly logger = new Logger(TaskMemoryService.name);

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly usersService: UsersService,
  ) {}

  private sanitizeSegment(id: string): string {
    return String(id ?? '')
      .replace(/[^a-zA-Z0-9_.-]/g, '_')
      .slice(0, 96);
  }

  private getSessionsDir(identifier: string): string {
    return this.workspaceService.getUserSessionsDir(identifier);
  }

  private getThreadTasksRoot(identifier: string, threadId: string): string {
    return path.join(
      this.getSessionsDir(identifier),
      this.sanitizeSegment(threadId),
      'tasks',
    );
  }

  private indexPath(identifier: string, threadId: string): string {
    return path.join(this.getThreadTasksRoot(identifier, threadId), INDEX_FILENAME);
  }

  private taskDir(
    identifier: string,
    threadId: string,
    taskId: string,
  ): string {
    return path.join(this.getThreadTasksRoot(identifier, threadId), taskId);
  }

  private statePath(
    identifier: string,
    threadId: string,
    taskId: string,
  ): string {
    return path.join(this.taskDir(identifier, threadId, taskId), STATE_FILENAME);
  }

  /** Chỉ bật bộ nhớ tác vụ cho luồng phức tạp (tool / suy luận dài) — tránh mọi smalltalk. */
  shouldUseTaskMemory(intent: IntentType, content: string): boolean {
    if (intent === IntentType.REASONING || intent === IntentType.BIG_DATA) {
      return true;
    }
    if (intent === IntentType.TOOL_CALL) {
      return true;
    }
    const t = String(content ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');
    if (/\[task:complex\]|\[tacvu:phuctap\]/i.test(content)) {
      return true;
    }
    if (
      /\b(nhiều\s*bước|nhieu\s*buoc|workflow|pipeline|bootstrap|run_skill|skills_registry|browser|trinh\s*duyet)\b/i.test(
        t,
      )
    ) {
      return true;
    }
    return false;
  }

  /** User đang tiếp tục tác vụ trước (cùng thread) thay vì mở tác vụ mới. */
  looksLikeContinuation(content: string): boolean {
    const c = String(content ?? '').trim();
    const t = c
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();

    if (c.length < 200 && /^\[task:[a-z0-9_.-]+\]/i.test(c)) return true;

    if (
      /^(tiếp|tiep|làm\s*tiếp|lam\s*tiep|thử\s*lại|thu\s*lai|retry|continue|resume|ok\s*tiếp|gửi\s*tiếp|theo\s*trên|như\s*trên|đồng\s*ý|dong\s*y)\b/i.test(
        c,
      )
    ) {
      return true;
    }

    // Bước tiếp / làm nốt / cùng task (tiếng Việt không dấu + có dấu)
    if (
      /\b(buoc\s*tiep\s*theo|bước\s*tiếp\s*theo|buoc\s*sau|bước\s*sau|lam\s*not|làm\s*nốt|phan\s*con\s*lai|phần\s*còn\s*lại|chua\s*xong|chưa\s*xong|tiep\s*tuc\s*xu\s*ly|tiếp\s*tục\s*xử\s*lý|theo\s*de\s*xuat|theo\s*đề\s*xuất|nối\s*(việc|viec|task)|cung\s*task|cùng\s*task|van\s*loi|vẫn\s*lỗi|loi\s*luc\s*nao|lỗi\s*lúc\s*nãy|vua\s*roi|vừa\s*rồi)\b/.test(
        t,
      )
    ) {
      return true;
    }

    // Nháp debug / draft — thường là bước sau của cùng luồng skill
    if (
      /\bdraftgroupid\b/i.test(c) ||
      /\bdraft(?:Group|_group)?\s*[:=]\s*["']?[a-f0-9]{8,}/i.test(c) ||
      /browser_debug\s*\/\s*[a-f0-9]{8,}/i.test(c) ||
      /skill_draft\.json|skill_tune|skillTune/i.test(c)
    ) {
      return true;
    }

    if (
      /\b(next\s*step|continue\s+with|pick\s*up\s*where|same\s*task|unblock|finish\s+(this|it))\b/i.test(
        t,
      )
    ) {
      return true;
    }

    return false;
  }

  /**
   * Gắn task cho lượt hiện tại: tạo task mới hoặc nối task đang mở; inject system prompt.
   */
  async attachForTurn(
    context: {
      runId: string;
      userId: number;
      threadId: string;
      processedContent: string;
      conversationHistory: Array<{ role: string; content?: string }>;
      metadata: Record<string, unknown>;
    },
    intent: IntentType,
  ): Promise<void> {
    const content = context.processedContent ?? '';
    if (!this.shouldUseTaskMemory(intent, content)) {
      context.metadata['taskMemory'] = { mode: 'off' as const };
      return;
    }

    const user = await this.usersService.findById(context.userId);
    if (!user?.identifier) {
      context.metadata['taskMemory'] = { mode: 'off' as const };
      return;
    }

    const identifier = user.identifier;
    const threadId = context.threadId;
    const root = this.getThreadTasksRoot(identifier, threadId);
    await fs.mkdir(root, { recursive: true });

    const index = await this.readIndex(identifier, threadId);
    const cont = this.looksLikeContinuation(content);
    let taskId: string;
    let state: TaskMemoryState;

    const explicitTask = content.match(/^\[task:([a-zA-Z0-9_.-]+)\]/i);
    if (explicitTask) {
      taskId = explicitTask[1];
      state = await this.readState(identifier, threadId, taskId);
      if (!state.taskId) {
        state = await this.createNewTaskWithId(
          identifier,
          threadId,
          index,
          taskId,
          content.replace(/^\[task:[^\]]+\]\s*/i, '').trim() || content,
        );
      }
    } else if (cont) {
      const open = [...index.tasks].reverse().find((x) => x.status === 'open');
      if (open) {
        taskId = open.taskId;
        state = await this.readState(identifier, threadId, taskId);
      } else {
        state = await this.createNewTask(identifier, threadId, index, content);
        taskId = state.taskId;
      }
    } else {
      state = await this.createNewTask(identifier, threadId, index, content);
      taskId = state.taskId;
    }

    const promptBlock = this.buildPromptBlock(state);
    context.metadata['taskMemory'] = {
      mode: 'active' as const,
      taskId: state.taskId,
      ordinal: state.ordinal,
      threadId,
      identifier,
      statePath: this.statePath(identifier, threadId, state.taskId),
      promptBlock,
      failedRunStreak: state.failedRunStreak ?? 0,
    };

    const insertAt =
      context.conversationHistory.length > 0 &&
      context.conversationHistory[0].role === 'system'
        ? 1
        : 0;
    context.conversationHistory.splice(insertAt, 0, {
      role: 'system',
      content: promptBlock,
    });

    this.logger.log(
      `[${context.runId}] Task memory active: ${state.taskId} (ordinal=${state.ordinal})`,
    );
  }

  /**
   * Ghi checkpoint sau khi agent chạy (tool đã thực thi).
   */
  async recordAfterAgentRun(context: {
    runId: string;
    metadata: Record<string, unknown>;
    agentToolCalls?: Array<{ skillCode: string; result: unknown }>;
  }): Promise<void> {
    const tm = context.metadata['taskMemory'] as
      | {
          mode: string;
          taskId?: string;
          identifier?: string;
          threadId?: string;
        }
      | undefined;
    if (!tm || tm.mode !== 'active' || !tm.taskId || !tm.identifier) return;

    const calls = context.agentToolCalls ?? [];
    if (!calls.length) return;

    const summary = calls
      .map((c) => {
        const r = c.result as Record<string, unknown> | undefined;
        const ok =
          r && typeof r === 'object' && 'success' in r
            ? String(r.success)
            : '?';
        return `${c.skillCode}(success=${ok})`;
      })
      .join('; ');

    const state = await this.readState(
      tm.identifier,
      tm.threadId!,
      tm.taskId,
    );
    if (!state.taskId) return;

    const failedToolCalls = calls.filter((c) => {
      const r = c.result as Record<string, unknown> | undefined;
      return r && typeof r === 'object' && r.success === false;
    }).length;
    const allSucceeded = calls.every((c) => {
      const r = c.result as Record<string, unknown> | undefined;
      return r && typeof r === 'object' && r.success === true;
    });

    let streak = state.failedRunStreak ?? 0;
    if (allSucceeded) {
      streak = 0;
    } else if (failedToolCalls > 0) {
      streak = Math.min(streak + failedToolCalls, 99);
    }
    state.failedRunStreak = streak;

    state.checkpoints.push({
      runId: context.runId,
      at: new Date().toISOString(),
      summary: summary.slice(0, 2000),
    });
    if (state.checkpoints.length > 40) {
      state.checkpoints = state.checkpoints.slice(-40);
    }
    state.updatedAt = new Date().toISOString();
    await this.writeState(tm.identifier, tm.threadId!, state);
    await this.syncIndexEntry(tm.identifier, tm.threadId!, state);
    this.logger.debug(
      `Task ${tm.taskId} checkpoint: ${summary.slice(0, 120)} (failedRunStreak=${streak})`,
    );
  }

  /** API cho skill task_memory / chỉnh tay. */
  async appendNote(
    identifier: string,
    threadId: string,
    taskId: string,
    note: string,
  ): Promise<TaskMemoryState | null> {
    const state = await this.readState(identifier, threadId, taskId);
    if (!state.taskId) return null;
    const add = String(note ?? '').trim();
    if (!add) return state;
    state.notes = `${state.notes}\n\n[${new Date().toISOString()}]\n${add}`.trim();
    state.updatedAt = new Date().toISOString();
    await this.writeState(identifier, threadId, state);
    await this.syncIndexEntry(identifier, threadId, state);
    return state;
  }

  async setStatus(
    identifier: string,
    threadId: string,
    taskId: string,
    status: TaskMemoryStatus,
  ): Promise<TaskMemoryState | null> {
    const state = await this.readState(identifier, threadId, taskId);
    if (!state.taskId) return null;
    state.status = status;
    state.updatedAt = new Date().toISOString();
    await this.writeState(identifier, threadId, state);
    await this.syncIndexEntry(identifier, threadId, state);
    return state;
  }

  async readStatePublic(
    identifier: string,
    threadId: string,
    taskId: string,
  ): Promise<TaskMemoryState | null> {
    const s = await this.readState(identifier, threadId, taskId);
    return s.taskId ? s : null;
  }

  listTasksFromIndex(
    identifier: string,
    threadId: string,
  ): Promise<TasksIndexFile['tasks']> {
    return this.readIndex(identifier, threadId).then((i) => i.tasks);
  }

  private buildPromptBlock(state: TaskMemoryState): string {
    const notes = state.notes?.trim()
      ? `\nGhi chú đã lưu:\n${state.notes.slice(0, 4000)}`
      : '';
    const recent = state.checkpoints.slice(-3);
    const cp = recent.length
      ? `\nCác bước gần nhất (checkpoint):\n${recent.map((c) => `- ${c.at}: ${c.summary}`).join('\n')}`
      : '';
    const streak = state.failedRunStreak ?? 0;
    const maxAsk = TASK_MEMORY_ASK_USER_AFTER_FAILED_STREAK;
    const policy =
      streak >= maxAsk
        ? `\n**Chính sách lượt lỗi:** failedRunStreak=${streak} (≥${maxAsk}). Được phép hỏi user hướng xử lý / thiếu thông tin bắt buộc nếu cần.`
        : `\n**Chính sách lượt lỗi (bắt buộc):** failedRunStreak=${streak}/${maxAsk}. ` +
          `CHƯA được hỏi user kiểu “chọn 1/2/3”, “bạn muốn A hay B”, hay “có muốn… không” chỉ để trì hoãn. ` +
          `Phải **tự gọi tool** (bootstrap_skill, run_skill, browser, …) theo PROCESSES/TOOLS cho đến khi xong hoặc hết lượt thử; ` +
          `chỉ hỏi lại khi **thiếu dữ liệu không thể suy ra** (vd. cookie, mật khẩu) hoặc streak đã ≥${maxAsk}.`;
    return (
      `[Task memory — chỉ mục tác vụ riêng, không trộn với tác vụ khác]\n` +
      `- taskId: \`${state.taskId}\` (ordinal #${state.ordinal} trong phiên này)\n` +
      `- Trạng thái: ${state.status}\n` +
      `- Tin user gốc (rút gọn): ${state.sourceUserMessagePreview.slice(0, 400)}${notes}${cp}\n` +
      policy +
      `\n- Khi cần ghi thêm / đóng tác vụ: dùng tool \`task_memory\` (append_note, set_status). ` +
      `Prefix tùy chọn \`[task:${state.taskId}]\` ở đầu tin để neo vào đúng tác vụ.`
    );
  }

  private async createNewTask(
    identifier: string,
    threadId: string,
    index: TasksIndexFile,
    sourceContent: string,
  ): Promise<TaskMemoryState> {
    const ordinal = index.tasks.length
      ? Math.max(...index.tasks.map((t) => t.ordinal)) + 1
      : 1;
    const short = randomBytes(4).toString('hex');
    const taskId = `task-${String(ordinal).padStart(3, '0')}-${short}`;
    const now = new Date().toISOString();
    const preview = String(sourceContent ?? '').replace(/\s+/g, ' ').slice(0, 280);

    const state: TaskMemoryState = {
      taskId,
      ordinal,
      threadId,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      sourceUserMessagePreview: preview,
      notes: '',
      checkpoints: [],
    };

    const dir = this.taskDir(identifier, threadId, taskId);
    await fs.mkdir(dir, { recursive: true });
    await this.writeState(identifier, threadId, state);

    index.tasks.push({
      taskId,
      ordinal,
      status: state.status,
      createdAt: now,
      updatedAt: now,
      sourcePreview: preview,
    });
    index.updatedAt = now;
    await this.writeIndex(identifier, threadId, index);

    return state;
  }

  /** Tạo task với taskId cố định (user dùng [task:...] lần đầu). */
  private async createNewTaskWithId(
    identifier: string,
    threadId: string,
    index: TasksIndexFile,
    taskId: string,
    sourceContent: string,
  ): Promise<TaskMemoryState> {
    const ordinal = index.tasks.length
      ? Math.max(...index.tasks.map((t) => t.ordinal)) + 1
      : 1;
    const now = new Date().toISOString();
    const preview = String(sourceContent ?? '').replace(/\s+/g, ' ').slice(0, 280);

    const state: TaskMemoryState = {
      taskId,
      ordinal,
      threadId,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      sourceUserMessagePreview: preview,
      notes: '',
      checkpoints: [],
    };

    const dir = this.taskDir(identifier, threadId, taskId);
    await fs.mkdir(dir, { recursive: true });
    await this.writeState(identifier, threadId, state);

    if (!index.tasks.some((t) => t.taskId === taskId)) {
      index.tasks.push({
        taskId,
        ordinal,
        status: state.status,
        createdAt: now,
        updatedAt: now,
        sourcePreview: preview,
      });
    }
    index.updatedAt = now;
    await this.writeIndex(identifier, threadId, index);

    return state;
  }

  private async readIndex(
    identifier: string,
    threadId: string,
  ): Promise<TasksIndexFile> {
    const p = this.indexPath(identifier, threadId);
    try {
      const raw = await fs.readFile(p, 'utf8');
      const j = JSON.parse(raw) as TasksIndexFile;
      if (j.version === 1 && Array.isArray(j.tasks)) return j;
    } catch {
      /* empty */
    }
    return {
      version: 1,
      threadId,
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
  }

  private async writeIndex(
    identifier: string,
    threadId: string,
    index: TasksIndexFile,
  ): Promise<void> {
    const p = this.indexPath(identifier, threadId);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(index, null, 2), 'utf8');
  }

  private async readState(
    identifier: string,
    threadId: string,
    taskId: string,
  ): Promise<TaskMemoryState> {
    const p = this.statePath(identifier, threadId, taskId);
    try {
      const raw = await fs.readFile(p, 'utf8');
      return JSON.parse(raw) as TaskMemoryState;
    } catch {
      return {} as TaskMemoryState;
    }
  }

  private async writeState(
    identifier: string,
    threadId: string,
    state: TaskMemoryState,
  ): Promise<void> {
    const p = this.statePath(identifier, threadId, state.taskId);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(state, null, 2), 'utf8');
  }

  private async syncIndexEntry(
    identifier: string,
    threadId: string,
    state: TaskMemoryState,
  ): Promise<void> {
    const index = await this.readIndex(identifier, threadId);
    const i = index.tasks.findIndex((t) => t.taskId === state.taskId);
    if (i >= 0) {
      index.tasks[i] = {
        ...index.tasks[i],
        status: state.status,
        updatedAt: state.updatedAt,
        sourcePreview: state.sourceUserMessagePreview.slice(0, 200),
      };
    }
    index.updatedAt = new Date().toISOString();
    await this.writeIndex(identifier, threadId, index);
  }

}
