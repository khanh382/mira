import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProvidersService } from '../providers/providers.service';
import { BackgroundLlmModelService } from '../pipeline/model-router/background-llm-model.service';
import { ChatService } from '../../modules/chat/chat.service';
import { MemoryManagerService } from '../../gateway/workspace/memory-manager.service';
import { UsersService } from '../../modules/users/users.service';
import { UserLevel } from '../../modules/users/entities/user.entity';

const MAX_INPUT_MESSAGES = 28;
const MAX_MSG_CHARS = 1200;

type Extracted = {
  projects?: string[];
  preferences?: string[];
  facts?: string[];
  decisions?: string[];
};

@Injectable()
export class InteractionMemoryService {
  private readonly logger = new Logger(InteractionMemoryService.name);
  private enabled = true;
  private modelId: string | null = null;
  private readonly chain = new Map<string, Promise<void>>();
  private readonly turnCount = new Map<string, number>();

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly providersService?: ProvidersService,
    @Optional() private readonly backgroundModel?: BackgroundLlmModelService,
    @Optional() private readonly chatService?: ChatService,
    @Optional() private readonly memoryManager?: MemoryManagerService,
    @Optional() private readonly usersService?: UsersService,
  ) {}

  async ensureInit(): Promise<void> {
    if (!this.enabled) return;
    if (this.modelId !== null) return;
    if (!this.providersService || !this.backgroundModel) {
      this.enabled = false;
      this.modelId = null;
      return;
    }
    try {
      this.modelId = await this.backgroundModel.resolveForBackgroundJob();
    } catch {
      this.modelId = null;
    }
  }

  scheduleAfterAssistantMessage(payload: {
    userId: number;
    identifier: string;
    threadId: string;
  }): void {
    if (this.configService.get<string>('INTERACTION_MEMORY_DISABLED') === 'true')
      return;

    const prev = this.chain.get(payload.threadId) ?? Promise.resolve();
    const job = prev
      .then(() => this.runExtractionJob(payload))
      .catch((e) =>
        this.logger.debug(
          `[thread ${payload.threadId}] interaction memory job: ${(e as Error).message}`,
        ),
      );
    this.chain.set(payload.threadId, job);
    void job.finally(() => {
      if (this.chain.get(payload.threadId) === job) {
        this.chain.delete(payload.threadId);
      }
    });
  }

  private shouldRunForUser(level: UserLevel): boolean {
    const scope = (this.configService.get<string>('INTERACTION_MEMORY_SCOPE') ??
      'owner') as string;
    if (scope === 'all') return true;
    if (scope === 'owner') return level === UserLevel.OWNER;
    return false;
  }

  private resolveInterval(): number {
    const raw = this.configService.get<string>('INTERACTION_MEMORY_INTERVAL_TURNS');
    const n = raw !== undefined && raw !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n < 1) return 8;
    return Math.min(Math.max(Math.floor(n), 1), 50);
  }

  private async runExtractionJob(payload: {
    userId: number;
    identifier: string;
    threadId: string;
  }): Promise<void> {
    await this.ensureInit();
    if (!this.enabled || !this.modelId) return;
    if (!this.chatService || !this.memoryManager || !this.usersService) return;

    const u = await this.usersService.findById(payload.userId);
    if (!u) return;
    if (!this.shouldRunForUser(u.level)) return;

    // Run every N assistant turns.
    const interval = this.resolveInterval();
    const current = (this.turnCount.get(payload.threadId) ?? 0) + 1;
    this.turnCount.set(payload.threadId, current);
    if (current % interval !== 0) return;

    const recent = await this.chatService.getRecentMessages(
      payload.threadId,
      MAX_INPUT_MESSAGES,
    );
    if (recent.length < 6) return;

    const sorted = [...recent].reverse();
    const transcript = sorted
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => {
        let c = (m.content ?? '').replace(/\s+/g, ' ').trim();
        if (c.length > MAX_MSG_CHARS) c = c.slice(0, MAX_MSG_CHARS) + '…';
        return `[${m.role}] ${c}`;
      })
      .join('\n');

    const system = `Bạn là bộ phận ghi nhớ dài hạn của một AI agent.
Nhiệm vụ: đọc transcript chat gần đây và trích ra những gì ĐÁNG LƯU LÂU DÀI.

Ràng buộc an toàn:
- KHÔNG lưu secrets (API keys, password, tokens, cookies, OTP, private keys).
- KHÔNG lưu dữ liệu nhạy cảm không cần thiết (PII thừa).
- Chỉ lưu thông tin có ích cho các lần tương tác sau.
- Nếu không có gì đáng lưu → trả về {}.

Trả về JSON object với các mảng string (tối đa 2 mục mỗi mảng):
{
  "projects": ["..."],
  "preferences": ["..."],
  "facts": ["..."],
  "decisions": ["..."]
}
Mỗi string là 1 bullet ngắn, cụ thể (file/URL/lệnh/quy ước). Không emoji.`;

    const res = await this.providersService.chat({
      model: this.modelId,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: transcript },
      ],
      temperature: 0.2,
      maxTokens: 500,
    });

    const raw = (res.content ?? '').trim();
    if (!raw) return;

    let parsed: Extracted | null = null;
    try {
      parsed = JSON.parse(raw) as Extracted;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;

    const append = (section: keyof Extracted, memSection: any) => {
      const items = (parsed as any)[section];
      if (!Array.isArray(items) || items.length === 0) return;
      for (const it of items.slice(0, 2)) {
        const s = String(it ?? '').replace(/\s+/g, ' ').trim();
        if (!s) continue;
        this.memoryManager!.appendBullet(payload.identifier, memSection, s);
      }
    };

    append('projects', 'projects');
    append('preferences', 'preferences');
    append('facts', 'facts');
    append('decisions', 'decisions');

    this.logger.debug(
      `[${payload.identifier}] Interaction memory extracted from thread ${payload.threadId.slice(0, 8)}…`,
    );
  }
}

