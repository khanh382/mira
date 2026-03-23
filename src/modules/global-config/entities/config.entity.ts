import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('config')
export class Config {
  @PrimaryGeneratedColumn({ name: 'cof_id' })
  id: number;

  @Column({ name: 'cof_openai_api_key', nullable: true })
  openaiApiKey: string;

  @Column({ name: 'cof_gemini_api_key', nullable: true })
  geminiApiKey: string;

  @Column({ name: 'cof_anthropic_api_key', nullable: true })
  anthropicApiKey: string;

  @Column({ name: 'cof_openrouter_api_key', nullable: true })
  openrouterApiKey: string;

  @Column({ name: 'cof_deepseek_api_key', nullable: true })
  deepseekApiKey: string;

  @Column({ name: 'cof_kimi_api_key', nullable: true })
  kimiApiKey: string;

  @Column({ name: 'cof_zai_api_key', nullable: true })
  zaiApiKey: string;

  @Column({ name: 'cof_perplexity_api_key', nullable: true })
  perplexityApiKey: string;

  @Column({ name: 'cof_brave_api_key', nullable: true })
  braveApiKey: string;

  @Column({ name: 'cof_firecrawl_api_key', nullable: true })
  firecrawlApiKey: string;

  // ─── Local LLM (Ollama / LM Studio) ───────────────────────────────
  /**
   * JSON: { "baseUrl": "http://localhost:11434", "apiKey": null }
   * apiKey: bỏ qua nếu Ollama không dùng auth.
   */
  @Column({ name: 'cof_ollama', type: 'jsonb', nullable: true })
  ollama: { baseUrl: string; apiKey?: string | null } | null;

  /**
   * JSON: { "baseUrl": "http://localhost:1234", "apiKey": null }
   * LM Studio mặc định không cần apiKey khi chạy local.
   */
  @Column({ name: 'cof_lms', type: 'jsonb', nullable: true })
  lmStudio: { baseUrl: string; apiKey?: string | null } | null;

  // ─── Scheduler / Heartbeat (quy tắc chung cho cron & heartbeat) ───
  /** Số lần thử lại tối đa trong 1 lượt tick (mặc định 3). Áp dụng cho mọi user. */
  @Column({ name: 'cof_scheduler_max_retries_per_tick', nullable: true })
  schedulerMaxRetriesPerTick: number | null;

  /** Số lượt tick liên tiếp fail tối đa trước khi tự đóng task (mặc định 3). */
  @Column({
    name: 'cof_scheduler_max_consecutive_failed_ticks',
    nullable: true,
  })
  schedulerMaxConsecutiveFailedTicks: number | null;
}
