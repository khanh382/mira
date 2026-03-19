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
    numResults: { type: 'number', description: 'Max results to return', default: 5 },
    lang: { type: 'string', description: 'Language code (e.g. "vi", "en")', default: 'en' },
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
  },
  required: ['query'],
};

@RegisterSkill({
  code: 'web_search',
  name: 'Web Search',
  description:
    'Search the web for real-time information using Brave Search or Perplexity API. ' +
    'Use when the user asks about current events, news, facts that may have changed, ' +
    'or any question requiring up-to-date information.',
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

    const braveKey = this.configService.get('BRAVE_API_KEY');
    const perplexityKey = this.configService.get('PERPLEXITY_API_KEY');

    try {
      if (braveKey) {
        return await this.searchWithBrave(
          query as string,
          { numResults: numResults as number, lang: lang as string, safesearch: safesearch as string },
          braveKey,
          start,
        );
      }

      if (perplexityKey) {
        return await this.searchWithPerplexity(query as string, perplexityKey, start);
      }

      return {
        success: false,
        error: 'No search API key configured. Set BRAVE_API_KEY or PERPLEXITY_API_KEY.',
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
      { headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' } },
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
      throw new Error(`Perplexity API ${response.status}: ${await response.text()}`);
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
}
