import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RegisterSkill } from '../../decorators/skill.decorator';
import {
  ISkillRunner,
  ISkillDefinition,
  ISkillExecutionContext,
  ISkillResult,
  SkillCategory,
  SkillType,
} from '../../interfaces/skill-runner.interface';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The URL to fetch and extract content from' },
    mode: {
      type: 'string',
      enum: ['markdown', 'text', 'html'],
      default: 'markdown',
      description: 'Output format',
    },
    maxChars: {
      type: 'number',
      description: 'Maximum characters to return',
      default: 20000,
    },
  },
  required: ['url'],
};

@RegisterSkill({
  code: 'web_fetch',
  name: 'Web Fetch',
  description:
    'Fetch and extract readable content from a URL. Returns clean markdown/text. ' +
    'Uses Firecrawl API if available, falls back to direct fetch with HTML-to-text conversion. ' +
    'Use when the user provides a URL and wants to read or summarize its content.',
  category: SkillCategory.WEB,
  parametersSchema: PARAMETERS_SCHEMA,
})
@Injectable()
export class WebFetchSkill implements ISkillRunner {
  private readonly logger = new Logger(WebFetchSkill.name);

  constructor(private readonly configService: ConfigService) {}

  get definition(): ISkillDefinition {
    return {
      code: 'web_fetch',
      name: 'Web Fetch',
      description: 'Fetch and extract readable content from a URL',
      category: SkillCategory.WEB,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const { url, mode = 'markdown', maxChars = 20000 } = context.parameters;

    try {
      const firecrawlKey = this.configService.get('FIRECRAWL_API_KEY');

      if (firecrawlKey) {
        return await this.fetchWithFirecrawl(
          url as string,
          mode as string,
          firecrawlKey,
          maxChars as number,
          start,
        );
      }

      return await this.fetchDirect(url as string, maxChars as number, start);
    } catch (error) {
      this.logger.error(`Web fetch failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        metadata: { durationMs: Date.now() - start },
      };
    }
  }

  private async fetchWithFirecrawl(
    url: string,
    mode: string,
    apiKey: string,
    maxChars: number,
    start: number,
  ): Promise<ISkillResult> {
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: [mode === 'html' ? 'html' : 'markdown'],
      }),
    });

    if (!response.ok) {
      throw new Error(`Firecrawl API ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    let content = data.data?.markdown || data.data?.html || '';
    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + '\n\n[...truncated]';
    }

    return {
      success: true,
      data: {
        url,
        title: data.data?.metadata?.title,
        content,
      },
      metadata: { durationMs: Date.now() - start, provider: 'firecrawl' },
    };
  }

  private async fetchDirect(
    url: string,
    maxChars: number,
    start: number,
  ): Promise<ISkillResult> {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'MiraBot/1.0' },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    let text = await response.text();

    // Naive HTML → text: strip tags
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + '\n\n[...truncated]';
    }

    return {
      success: true,
      data: { url, content: text },
      metadata: { durationMs: Date.now() - start, provider: 'direct' },
    };
  }
}
