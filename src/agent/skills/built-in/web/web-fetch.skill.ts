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
import { UsersService } from '../../../../modules/users/users.service';
import { UserLevel } from '../../../../modules/users/entities/user.entity';
import { assertUrlSafeForFetch } from './url-ssrf-guard';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'The URL to fetch and extract content from',
    },
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

  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {}

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

  /**
   * Chặn SSRF (localhost / private IP / metadata) **chỉ trên production**.
   * Trên dev (`NODE_ENV` ≠ `production`) mặc định **không** chặn — tiện test API nội bộ.
   * Ghi đè: `WEB_FETCH_SSRF_STRICT=false` để tắt chặn kể cả khi build production (staging).
   */
  private isSsrfEnforced(): boolean {
    if (process.env.NODE_ENV !== 'production') {
      return false;
    }
    return (
      String(this.configService.get('WEB_FETCH_SSRF_STRICT', 'true')).trim() !==
      'false'
    );
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const { url, mode = 'markdown', maxChars = 20000 } = context.parameters;
    const urlStr = String(url ?? '').trim();

    try {
      const user = await this.usersService.findById(context.userId);
      const allowPrivate =
        user?.level === UserLevel.OWNER &&
        String(this.configService.get('WEB_FETCH_ALLOW_PRIVATE_URLS', '')).trim() ===
          'true';

      if (this.isSsrfEnforced()) {
        await assertUrlSafeForFetch(urlStr, { allowPrivate });
      }

      const firecrawlKey = this.configService.get('FIRECRAWL_API_KEY');

      if (firecrawlKey) {
        return await this.fetchWithFirecrawl(
          urlStr,
          mode as string,
          firecrawlKey,
          maxChars as number,
          start,
          context,
        );
      }

      return await this.fetchDirect(
        urlStr,
        maxChars as number,
        start,
        context,
      );
    } catch (error) {
      this.logger.error(`Web fetch failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        metadata: { durationMs: Date.now() - start },
      };
    }
  }

  private mergeFetchSignal(context: ISkillExecutionContext): AbortSignal {
    const inner = AbortSignal.timeout(18_000);
    if (context.signal) {
      return AbortSignal.any([context.signal, inner]);
    }
    return inner;
  }

  private async fetchWithFirecrawl(
    url: string,
    mode: string,
    apiKey: string,
    maxChars: number,
    start: number,
    context: ISkillExecutionContext,
  ): Promise<ISkillResult> {
    const signal = this.mergeFetchSignal(context);
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
      signal,
    });

    if (!response.ok) {
      throw new Error(
        `Firecrawl API ${response.status}: ${await response.text()}`,
      );
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
    context: ISkillExecutionContext,
  ): Promise<ISkillResult> {
    const signal = this.mergeFetchSignal(context);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'MiraBot/1.0' },
      signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    let text = await response.text();

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
