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
    query: { type: 'string', description: 'The search query' },
    numResults: {
      type: 'number',
      description: 'Max results to return',
      default: 5,
    },
    lang: {
      type: 'string',
      description: 'Language code (e.g. "vi", "en")',
      default: 'en',
    },
    timeFilter: {
      type: 'string',
      enum: ['day', 'week', 'month', 'year'],
      description: 'Time range filter',
    },
    safesearch: {
      type: 'string',
      enum: ['off', 'moderate', 'strict'],
      default: 'moderate',
    },
    searchType: {
      type: 'string',
      enum: ['web', 'image'],
      default: 'web',
      description:
        'Google Custom Search only: `image` = Google Images (`searchType=image`). Requires GOOGLE_CUSTOM_SEARCH_*; ignored when using Brave/Perplexity as provider.',
    },
  },
  required: ['query'],
};

@RegisterSkill({
  code: 'web_search',
  name: 'Web Search',
  description:
    'Search the web using Brave Search, Perplexity, or Google Custom Search JSON API. ' +
    'For Google Images (keyword → image results), set searchType=image (Custom Search only). ' +
    'Use for current events, facts, or image lookup by query text.',
  category: SkillCategory.WEB,
  parametersSchema: PARAMETERS_SCHEMA,
})
@Injectable()
export class WebSearchSkill implements ISkillRunner {
  private readonly logger = new Logger(WebSearchSkill.name);

  constructor(private readonly configService: ConfigService) {}

  get definition(): ISkillDefinition {
    return {
      code: 'web_search',
      name: 'Web Search',
      description: 'Search the web for real-time information',
      category: SkillCategory.WEB,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const { query, numResults = 5, lang, safesearch } = context.parameters;
    const searchTypeParam = context.parameters.searchType as string | undefined;
    const googleSearchKind: 'web' | 'image' =
      searchTypeParam === 'image' ? 'image' : 'web';

    const braveKey = this.configService.get('BRAVE_API_KEY');
    const perplexityKey = this.configService.get('PERPLEXITY_API_KEY');
    const googleCseKey = trimEnv(
      this.configService.get<string>('GOOGLE_CUSTOM_SEARCH_API_KEY'),
    );
    const googleCseCx = trimEnv(
      this.configService.get<string>('GOOGLE_CUSTOM_SEARCH_ENGINE_ID'),
    );

    try {
      if (googleSearchKind === 'image') {
        if (!googleCseKey || !googleCseCx) {
          return {
            success: false,
            error:
              'searchType=image dùng Google Custom Search (`searchType=image`). Cần GOOGLE_CUSTOM_SEARCH_API_KEY và GOOGLE_CUSTOM_SEARCH_ENGINE_ID. ' +
              'Brave/Perplexity không hỗ trợ tham số này — tạm tắt BRAVE_/PERPLEXITY_ hoặc dùng searchType=web.',
            metadata: { durationMs: Date.now() - start },
          };
        }
        return await this.searchWithGoogleCustomSearch(
          query as string,
          {
            numResults: numResults as number,
            lang: lang as string,
            safesearch: safesearch as string,
            timeFilter: context.parameters.timeFilter as string | undefined,
            googleSearchKind: 'image',
          },
          googleCseKey,
          googleCseCx,
          start,
        );
      }

      if (braveKey) {
        return await this.searchWithBrave(
          query as string,
          {
            numResults: numResults as number,
            lang: lang as string,
            safesearch: safesearch as string,
          },
          braveKey,
          start,
        );
      }

      if (perplexityKey) {
        return await this.searchWithPerplexity(
          query as string,
          perplexityKey,
          start,
        );
      }

      if (googleCseKey && googleCseCx) {
        return await this.searchWithGoogleCustomSearch(
          query as string,
          {
            numResults: numResults as number,
            lang: lang as string,
            safesearch: safesearch as string,
            timeFilter: context.parameters.timeFilter as string | undefined,
            googleSearchKind: 'web',
          },
          googleCseKey,
          googleCseCx,
          start,
        );
      }

      if (googleCseKey && !googleCseCx) {
        return {
          success: false,
          error:
            'Google Custom Search: đã có GOOGLE_CUSTOM_SEARCH_API_KEY nhưng thiếu GOOGLE_CUSTOM_SEARCH_ENGINE_ID (cx). ' +
            'Vào https://programmablesearchengine.google.com/ tạo engine, bật “Search the entire web”, copy Search engine ID vào .env.',
          metadata: { durationMs: Date.now() - start },
        };
      }

      if (!googleCseKey && googleCseCx) {
        return {
          success: false,
          error:
            'Google Custom Search: có GOOGLE_CUSTOM_SEARCH_ENGINE_ID nhưng thiếu GOOGLE_CUSTOM_SEARCH_API_KEY.',
          metadata: { durationMs: Date.now() - start },
        };
      }

      return {
        success: false,
        error:
          'No search API configured. Set BRAVE_API_KEY, or PERPLEXITY_API_KEY, or ' +
          'GOOGLE_CUSTOM_SEARCH_API_KEY + GOOGLE_CUSTOM_SEARCH_ENGINE_ID (Programmable Search cx).',
        metadata: { durationMs: Date.now() - start },
      };
    } catch (error) {
      this.logger.error(`Web search failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        metadata: { durationMs: Date.now() - start },
      };
    }
  }

  private async searchWithBrave(
    query: string,
    options: { numResults: number; lang?: string; safesearch?: string },
    apiKey: string,
    start: number,
  ): Promise<ISkillResult> {
    const params = new URLSearchParams({
      q: query,
      count: String(options.numResults),
    });
    if (options.lang) params.set('search_lang', options.lang);
    if (options.safesearch) params.set('safesearch', options.safesearch);

    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?${params}`,
      {
        headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
      },
    );

    if (!response.ok) {
      throw new Error(`Brave API ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const results = (data.web?.results || []).map((r: any) => ({
      title: r.title,
      url: r.url,
      description: r.description,
    }));

    return {
      success: true,
      data: { query, results, totalResults: data.web?.totalResults },
      metadata: { durationMs: Date.now() - start, provider: 'brave' },
    };
  }

  private async searchWithPerplexity(
    query: string,
    apiKey: string,
    start: number,
  ): Promise<ISkillResult> {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: query }],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Perplexity API ${response.status}: ${await response.text()}`,
      );
    }

    const data = await response.json();
    return {
      success: true,
      data: {
        query,
        answer: data.choices?.[0]?.message?.content,
        citations: data.citations,
      },
      metadata: { durationMs: Date.now() - start, provider: 'perplexity' },
    };
  }

  /** Google Custom Search JSON API — tối đa 10 kết quả mỗi request. `searchType=image` = Google Images. */
  private async searchWithGoogleCustomSearch(
    query: string,
    options: {
      numResults: number;
      lang?: string;
      safesearch?: string;
      timeFilter?: string;
      googleSearchKind: 'web' | 'image';
    },
    apiKey: string,
    cx: string,
    start: number,
  ): Promise<ISkillResult> {
    const num = Math.min(Math.max(1, Math.floor(options.numResults || 5)), 10);
    const params = new URLSearchParams({
      key: apiKey,
      cx,
      q: query,
      num: String(num),
    });

    if (options.googleSearchKind === 'image') {
      params.set('searchType', 'image');
    }

    if (options.lang) {
      const code = String(options.lang).replace(/_/g, '-').toLowerCase();
      if (code.length >= 2) {
        params.set('lr', `lang_${code.slice(0, 2)}`);
      }
    }

    const safe = (options.safesearch || 'moderate').toLowerCase();
    if (safe === 'strict' || safe === 'moderate') {
      params.set('safe', 'active');
    } else {
      params.set('safe', 'off');
    }

    const dr = googleCseDateRestrict(options.timeFilter);
    if (dr) params.set('dateRestrict', dr);

    const response = await fetch(
      `https://www.googleapis.com/customsearch/v1?${params}`,
      { headers: { Accept: 'application/json' } },
    );

    if (!response.ok) {
      throw new Error(
        `Google Custom Search ${response.status}: ${await response.text()}`,
      );
    }

    const data = (await response.json()) as {
      items?: Array<{
        title?: string;
        link?: string;
        snippet?: string;
        displayLink?: string;
        image?: {
          contextLink?: string;
          thumbnailLink?: string;
          width?: number;
          height?: number;
        };
      }>;
      searchInformation?: { totalResults?: string };
    };

    const isImage = options.googleSearchKind === 'image';
    const results = (data.items || []).map((r) => {
      if (isImage) {
        return {
          title: r.title,
          url: r.link,
          description: r.snippet,
          thumbnailUrl: r.image?.thumbnailLink,
          contextUrl: r.image?.contextLink,
          displayLink: r.displayLink,
          width: r.image?.width,
          height: r.image?.height,
        };
      }
      return {
        title: r.title,
        url: r.link,
        description: r.snippet,
      };
    });

    const total = data.searchInformation?.totalResults;

    return {
      success: true,
      data: {
        query,
        searchType: options.googleSearchKind,
        results,
        totalResults: total != null ? Number(total) : undefined,
      },
      metadata: {
        durationMs: Date.now() - start,
        provider:
          options.googleSearchKind === 'image'
            ? 'google_cse_image'
            : 'google_cse',
      },
    };
  }
}

function trimEnv(v: string | undefined): string {
  if (v == null || typeof v !== 'string') return '';
  return v.trim();
}

function googleCseDateRestrict(
  timeFilter: string | undefined,
): string | undefined {
  if (!timeFilter) return undefined;
  switch (timeFilter) {
    case 'day':
      return 'd1';
    case 'week':
      return 'w1';
    case 'month':
      return 'm1';
    case 'year':
      return 'y1';
    default:
      return undefined;
  }
}
