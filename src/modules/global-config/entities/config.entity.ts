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
}
