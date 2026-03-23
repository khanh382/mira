import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RegisterSkill } from '../../decorators/skill.decorator';
import {
  ISkillDefinition,
  ISkillExecutionContext,
  ISkillResult,
  ISkillRunner,
  SkillCategory,
  SkillType,
} from '../../interfaces/skill-runner.interface';
import { UsersService } from '../../../../modules/users/users.service';
import { UserLevel } from '../../../../modules/users/entities/user.entity';
import { HttpTokensService } from '../../../../modules/http-tokens/http-tokens.service';
import { HttpTokenAuthType } from '../../../../modules/http-tokens/entities/http-token.entity';
import { assertUrlSafeForFetch } from './url-ssrf-guard';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'Full target URL (e.g. https://site.com/wp-json/wp/v2/posts)',
    },
    method: {
      type: 'string',
      enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      default: 'GET',
      description: 'HTTP method',
    },
    query: {
      type: 'object',
      description: 'Query params object, appended to URL',
      additionalProperties: true,
    },
    headers: {
      type: 'object',
      description: 'Additional request headers',
      additionalProperties: { type: 'string' },
    },
    body: {
      type: 'object',
      description: 'Request body for write methods',
      additionalProperties: true,
    },
    rawBody: {
      type: 'string',
      description: 'Raw body string (used when body is not JSON)',
    },
    authDomain: {
      type: 'string',
      description: 'Optional domain override to resolve auth token record',
    },
    requireExplicitDomain: {
      type: 'boolean',
      description:
        'If true on write methods, require explicit authDomain; otherwise ask user which domain to execute on.',
      default: false,
    },
    timeoutMs: {
      type: 'number',
      default: 20000,
      description: 'Request timeout in milliseconds',
    },
    maxChars: {
      type: 'number',
      default: 20000,
      description: 'Maximum response content size returned',
    },
  },
  required: ['url'],
};

@RegisterSkill({
  code: 'http_request',
  name: 'HTTP Request',
  description:
    'Call REST APIs with GET/POST/PUT/PATCH/DELETE and return response body/status. ' +
    'Supports per-domain token auth from http_tokens table (api_key, bearer, basic). ' +
    'Useful for WordPress and other APIs without using exec/curl.',
  category: SkillCategory.WEB,
  parametersSchema: PARAMETERS_SCHEMA,
})
@Injectable()
export class HttpRequestSkill implements ISkillRunner {
  private readonly logger = new Logger(HttpRequestSkill.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly httpTokensService: HttpTokensService,
  ) {}

  get definition(): ISkillDefinition {
    return {
      code: 'http_request',
      name: 'HTTP Request',
      description:
        'Call REST APIs with GET/POST/PUT/PATCH/DELETE using per-domain auth',
      category: SkillCategory.WEB,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
    };
  }

  private isSsrfEnforced(): boolean {
    if (process.env.NODE_ENV !== 'production') return false;
    return (
      String(this.configService.get('HTTP_REQUEST_SSRF_STRICT', 'true')).trim() !==
      'false'
    );
  }

  private parseAllowlist(): string[] {
    return String(
      this.configService.get('HTTP_REQUEST_COLLEAGUE_DOMAIN_ALLOWLIST', ''),
    )
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
      .map((x) => x.replace(/^www\./, ''));
  }

  private isDomainAllowedForColleague(hostname: string): boolean {
    const host = String(hostname ?? '').trim().toLowerCase().replace(/^www\./, '');
    const allowlist = this.parseAllowlist();
    return allowlist.some((d) => host === d || host.endsWith(`.${d}`));
  }

  private buildUrl(url: string, query?: Record<string, unknown>): URL {
    const u = new URL(url);
    if (!query || typeof query !== 'object') return u;
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      u.searchParams.set(k, String(v));
    }
    return u;
  }

  private mergeSignals(
    contextSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): AbortSignal {
    const inner = AbortSignal.timeout(timeoutMs);
    if (contextSignal) return AbortSignal.any([contextSignal, inner]);
    return inner;
  }

  private normalizeHeaders(
    input: Record<string, unknown> | undefined,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    if (!input || typeof input !== 'object') return out;
    for (const [k, v] of Object.entries(input)) {
      if (!k || v == null) continue;
      out[k] = String(v);
    }
    return out;
  }

  private async buildAuthHeaders(
    authDomain: string | undefined,
    urlHost: string,
  ): Promise<Record<string, string>> {
    const domain = String(authDomain ?? '').trim() || urlHost;
    const row = await this.httpTokensService.getByDomain(domain);
    if (!row) return {};

    if (row.authType === HttpTokenAuthType.API_KEY) {
      const headerName = String(row.headerName ?? '').trim() || 'x-api-key';
      return { [headerName]: row.token };
    }
    if (row.authType === HttpTokenAuthType.BEARER) {
      return { Authorization: `Bearer ${row.token}` };
    }
    if (row.authType === HttpTokenAuthType.BASIC) {
      const user = String(row.username ?? '').trim();
      const basic = Buffer.from(`${user}:${row.token}`).toString('base64');
      return { Authorization: `Basic ${basic}` };
    }
    return {};
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    try {
      const params = context.parameters ?? {};
      const url = String(params.url ?? '').trim();
      if (!url) throw new Error('url is required');

      const method = String(params.method ?? 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        throw new Error('method must be one of GET/POST/PUT/PATCH/DELETE');
      }

      const timeoutMs = Math.max(1000, Number(params.timeoutMs ?? 20000));
      const maxChars = Math.max(1000, Number(params.maxChars ?? 20000));
      const requireExplicitDomain =
        params.requireExplicitDomain === true ||
        String(params.requireExplicitDomain ?? '').toLowerCase() === 'true';
      const query =
        params.query && typeof params.query === 'object'
          ? (params.query as Record<string, unknown>)
          : undefined;
      const headers = this.normalizeHeaders(
        params.headers as Record<string, unknown>,
      );
      const finalUrl = this.buildUrl(url, query);
      const host = finalUrl.hostname.toLowerCase().replace(/^www\./, '');
      const writeMethod = method !== 'GET';
      const explicitAuthDomain = String(params.authDomain ?? '').trim();

      if (writeMethod && requireExplicitDomain && !explicitAuthDomain) {
        return {
          success: false,
          error:
            'Bạn muốn thực thi trên domain nào? Vui lòng cung cấp rõ `authDomain` (hoặc `baseUrl` ở skill WordPress) rồi chạy lại.',
          data: {
            requiresDomainConfirmation: true,
            suggestedField: 'authDomain',
          },
          metadata: { durationMs: Date.now() - start },
        };
      }

      const user = await this.usersService.findById(context.userId);
      const allowPrivate =
        user?.level === UserLevel.OWNER &&
        String(
          this.configService.get('HTTP_REQUEST_ALLOW_PRIVATE_URLS', ''),
        ).trim() === 'true';

      if (this.isSsrfEnforced()) {
        await assertUrlSafeForFetch(finalUrl.toString(), { allowPrivate });
      }

      if (
        user?.level === UserLevel.COLLEAGUE &&
        !this.isDomainAllowedForColleague(host)
      ) {
        throw new Error(
          'Domain not allowed for colleague. Set HTTP_REQUEST_COLLEAGUE_DOMAIN_ALLOWLIST.',
        );
      }

      const authHeaders = await this.buildAuthHeaders(
        explicitAuthDomain || undefined,
        host,
      );
      const mergedHeaders: Record<string, string> = {
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
        ...authHeaders,
        ...headers,
      };

      let bodyToSend: string | undefined;
      if (method !== 'GET' && method !== 'DELETE') {
        if (typeof params.rawBody === 'string') {
          bodyToSend = params.rawBody;
        } else if (params.body != null) {
          bodyToSend = JSON.stringify(params.body);
          if (!mergedHeaders['Content-Type'] && !mergedHeaders['content-type']) {
            mergedHeaders['Content-Type'] = 'application/json';
          }
        }
      }

      const signal = this.mergeSignals(context.signal, timeoutMs);
      const response = await fetch(finalUrl.toString(), {
        method,
        headers: mergedHeaders,
        body: bodyToSend,
        signal,
      });

      const contentType = String(response.headers.get('content-type') ?? '');
      const responseText = await response.text();
      const trimmed =
        responseText.length > maxChars
          ? `${responseText.slice(0, maxChars)}\n\n[...truncated]`
          : responseText;

      let json: unknown = undefined;
      if (contentType.includes('application/json')) {
        try {
          json = JSON.parse(responseText);
        } catch {
          json = undefined;
        }
      }

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status} ${response.statusText}`,
          data: {
            url: finalUrl.toString(),
            method,
            status: response.status,
            statusText: response.statusText,
            contentType,
            body: json ?? trimmed,
          },
          metadata: { durationMs: Date.now() - start },
        };
      }

      return {
        success: true,
        data: {
          url: finalUrl.toString(),
          method,
          status: response.status,
          statusText: response.statusText,
          contentType,
          body: json ?? trimmed,
        },
        metadata: { durationMs: Date.now() - start },
      };
    } catch (error) {
      this.logger.error(`http_request failed: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message,
        metadata: { durationMs: Date.now() - start },
      };
    }
  }
}
