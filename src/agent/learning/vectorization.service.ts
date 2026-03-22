import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { ChatService } from '../../modules/chat/chat.service';
import { GlobalConfigService } from '../../modules/global-config/global-config.service';
import { ChatMessage } from '../../modules/chat/entities/chat-message.entity';
import { DEFAULT_BRAIN_DIR } from '../../config/brain-dir.config';

const BATCH_SIZE = 50;
const MAX_BATCHES_PER_RUN = 20;

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface IEmbeddingResult {
  id: string;
  vector: number[];
}

/**
 * VectorizationService — Cronjob "Học để nhớ dai" (RAG pipeline).
 *
 * 3h sáng mỗi ngày (UTC+7):
 * 1. Gom chat_messages chưa vectorize (is_vectorized = false)
 * 2. Gọi embedding model → vector 1536d
 * 3. Lưu vào Vector DB (pgvector / Qdrant / Milvus)
 * 4. Đánh dấu is_vectorized = true
 *
 * Chạy song song không ảnh hưởng tác vụ khác (async, batched).
 */
@Injectable()
export class VectorizationService {
  private readonly logger = new Logger(VectorizationService.name);
  private running = false;

  constructor(
    private readonly chatService: ChatService,
    private readonly configService: ConfigService,
    private readonly globalConfigService: GlobalConfigService,
  ) {}

  /**
   * 3h sáng mỗi ngày (TZ=Asia/Ho_Chi_Minh trong .env).
   * Cron expression: second(0) minute(0) hour(3) * * *
   */
  @Cron('0 0 3 * * *', {
    name: 'vectorize_messages',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async runScheduled(): Promise<void> {
    // Không chặn callback cron; tách sang tick sau để nhường event loop chính.
    setImmediate(() => {
      void this.vectorizeAll().catch((e) =>
        this.logger.error(`Vectorization (deferred) failed: ${e?.message}`, e),
      );
    });
  }

  async vectorizeAll(): Promise<{ processed: number; batches: number }> {
    if (this.running) {
      this.logger.debug('Vectorization already running, skipping');
      return { processed: 0, batches: 0 };
    }

    this.running = true;
    let totalProcessed = 0;
    let batchCount = 0;

    try {
      const embeddingModel = await this.resolveEmbeddingModel();
      if (!embeddingModel) {
        this.logger.warn(
          'No embedding model available, skipping vectorization',
        );
        return { processed: 0, batches: 0 };
      }

      for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
        const messages = await this.chatService.findUnvectorized(BATCH_SIZE);
        if (messages.length === 0) break;

        batchCount++;
        const count = await this.processBatch(messages, embeddingModel);
        totalProcessed += count;

        this.logger.debug(
          `Vectorize batch ${batchCount}: ${count}/${messages.length} messages`,
        );
        await yieldEventLoop();
      }

      if (totalProcessed > 0) {
        this.logger.log(
          `Vectorization complete: ${totalProcessed} messages in ${batchCount} batches`,
        );
      }
    } catch (error) {
      this.logger.error(`Vectorization failed: ${error.message}`, error.stack);
    } finally {
      this.running = false;
    }

    return { processed: totalProcessed, batches: batchCount };
  }

  private async processBatch(
    messages: ChatMessage[],
    embeddingModel: string,
  ): Promise<number> {
    const texts = messages.map((m) => this.buildEmbeddingText(m));

    const embeddings = await this.embed(texts, embeddingModel);
    if (!embeddings || embeddings.length === 0) return 0;

    await this.storeVectors(
      messages.map((m, i) => ({
        id: m.id,
        threadId: m.threadId,
        userId: m.userId,
        role: m.role,
        content: m.content,
        vector: embeddings[i],
        createdAt: m.createdAt,
      })),
    );

    const ids = messages.map((m) => m.id);
    await this.chatService.markVectorized(ids);

    return messages.length;
  }

  private buildEmbeddingText(message: ChatMessage): string {
    const prefix = message.role === 'user' ? 'User' : 'Assistant';
    const text = message.content.slice(0, 8000);
    return `[${prefix}] ${text}`;
  }

  // ─── Embedding API ────────────────────────────────────────

  private async embed(
    texts: string[],
    model: string,
  ): Promise<number[][] | null> {
    const apiKey = await this.globalConfigService.getApiKey('openai');

    if (apiKey) {
      return this.embedViaOpenAI(texts, apiKey, model);
    }

    const geminiKey = await this.globalConfigService.getApiKey('gemini');
    if (geminiKey) {
      return this.embedViaGemini(texts, geminiKey);
    }

    return null;
  }

  private async embedViaOpenAI(
    texts: string[],
    apiKey: string,
    model: string,
  ): Promise<number[][]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: texts,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI Embedding API ${response.status}: ${await response.text()}`,
      );
    }

    const data = await response.json();
    return data.data.map((d: any) => d.embedding);
  }

  private async embedViaGemini(
    texts: string[],
    apiKey: string,
  ): Promise<number[][]> {
    const results: number[][] = [];

    for (const text of texts) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/text-embedding-004:embedContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'models/text-embedding-004',
            content: { parts: [{ text }] },
          }),
        },
      );

      if (!response.ok) {
        throw new Error(
          `Gemini Embedding API ${response.status}: ${await response.text()}`,
        );
      }

      const data = await response.json();
      results.push(data.embedding.values);
    }

    return results;
  }

  // ─── Vector Storage ───────────────────────────────────────

  /**
   * Lưu vectors vào storage.
   *
   * Hỗ trợ 2 backend:
   * 1. pgvector (PostgreSQL extension) — nếu có table `message_vectors`
   * 2. File-based fallback — lưu .json trong BRAIN_DIR/_vectors/
   *
   * Production nên dùng pgvector hoặc Qdrant.
   */
  private async storeVectors(
    entries: Array<{
      id: string;
      threadId: string;
      userId: number;
      role: string;
      content: string;
      vector: number[];
      createdAt: Date;
    }>,
  ): Promise<void> {
    const vectorDir = this.getVectorDir();
    const fs = await import('fs/promises');
    const path = await import('path');

    await fs.mkdir(vectorDir, { recursive: true });

    for (const entry of entries) {
      const userDir = path.join(vectorDir, String(entry.userId));
      await fs.mkdir(userDir, { recursive: true });

      const filePath = path.join(userDir, `${entry.id}.json`);
      await fs.writeFile(
        filePath,
        JSON.stringify({
          id: entry.id,
          threadId: entry.threadId,
          userId: entry.userId,
          role: entry.role,
          content: entry.content.slice(0, 2000),
          vector: entry.vector,
          createdAt: entry.createdAt.toISOString(),
        }),
      );
    }
  }

  /**
   * Tìm kiếm semantic: embed query → cosine similarity với stored vectors.
   * Dùng bởi memory_search skill.
   */
  async search(
    userId: number,
    query: string,
    options?: { maxResults?: number; minScore?: number },
  ): Promise<
    Array<{
      id: string;
      content: string;
      score: number;
      role: string;
      createdAt: string;
    }>
  > {
    const maxResults = options?.maxResults ?? 5;
    const minScore = options?.minScore ?? 0.7;

    const embeddingModel = await this.resolveEmbeddingModel();
    if (!embeddingModel) return [];

    const queryEmbedding = await this.embed([query], embeddingModel);
    if (!queryEmbedding?.[0]) return [];

    const queryVec = queryEmbedding[0];
    const candidates = await this.loadUserVectors(userId);

    const scored = candidates.map((c) => ({
      ...c,
      score: this.cosineSimilarity(queryVec, c.vector),
    }));

    return scored
      .filter((c) => c.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(({ vector, ...rest }) => rest);
  }

  private async loadUserVectors(userId: number): Promise<
    Array<{
      id: string;
      content: string;
      role: string;
      vector: number[];
      createdAt: string;
    }>
  > {
    const fs = await import('fs');
    const path = await import('path');

    const userDir = path.join(this.getVectorDir(), String(userId));
    if (!fs.existsSync(userDir)) return [];

    const files = fs.readdirSync(userDir).filter((f) => f.endsWith('.json'));
    const results: any[] = [];

    for (const file of files) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(userDir, file), 'utf-8'),
        );
        results.push(data);
      } catch {
        // skip corrupt files
      }
    }

    return results;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0,
      magA = 0,
      magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
    return magnitude === 0 ? 0 : dot / magnitude;
  }

  private getVectorDir(): string {
    const path = require('path');
    const brainDir = this.configService.get('BRAIN_DIR', DEFAULT_BRAIN_DIR);
    return path.resolve(brainDir, '_vectors');
  }

  private async resolveEmbeddingModel(): Promise<string | null> {
    const openaiKey = await this.globalConfigService.getApiKey('openai');
    if (openaiKey) return 'text-embedding-3-small';

    const geminiKey = await this.globalConfigService.getApiKey('gemini');
    if (geminiKey) return 'text-embedding-004';

    return null;
  }
}
