import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildSignedHeaders,
  ISignedHeaders,
} from './n8n-signature.util';
import { IN8nDispatchRequestBody } from './n8n-contract';

@Injectable()
export class N8nClientService {
  private readonly logger = new Logger(N8nClientService.name);

  constructor(private readonly config: ConfigService) {}

  private getDispatchUrlOrThrow(): string {
    const url = String(this.config.get('N8N_DISPATCH_URL', '') || '').trim();
    if (!url) {
      throw new Error('N8N_DISPATCH_URL is not configured');
    }
    return url;
  }

  private getDispatchSecretOrThrow(): string {
    const s = String(this.config.get('N8N_DISPATCH_SECRET', '') || '').trim();
    if (!s) {
      throw new Error('N8N_DISPATCH_SECRET is not configured');
    }
    return s;
  }

  private resolveTimeoutMs(): number {
    const raw = this.config.get<string>('N8N_DISPATCH_TIMEOUT_MS', '12000');
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 2000) return 12000;
    return Math.min(Math.floor(n), 60000);
  }

  private buildHeaders(body: IN8nDispatchRequestBody): ISignedHeaders & {
    'content-type': string;
  } {
    const secret = this.getDispatchSecretOrThrow();
    const signed = buildSignedHeaders({ secret, body });
    return {
      ...signed,
      'content-type': 'application/json',
    };
  }

  async dispatch(body: IN8nDispatchRequestBody): Promise<{
    ok: boolean;
    status: number;
    data?: unknown;
    error?: string;
  }> {
    const url = this.getDispatchUrlOrThrow();
    const timeoutMs = this.resolveTimeoutMs();
    const started = Date.now();

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(body) as unknown as Record<string, string>,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const status = res.status;
      const text = await res.text().catch(() => '');
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // keep raw text
      }

      if (!res.ok) {
        this.logger.warn(
          `n8n dispatch failed status=${status} elapsedMs=${Date.now() - started}`,
        );
        return {
          ok: false,
          status,
          error:
            typeof parsed === 'string'
              ? parsed.slice(0, 2000)
              : `HTTP ${status}`,
          data: typeof parsed === 'string' ? undefined : parsed,
        };
      }

      return { ok: true, status, data: parsed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `n8n dispatch error elapsedMs=${Date.now() - started}: ${msg}`,
      );
      return { ok: false, status: 0, error: msg };
    } finally {
      clearTimeout(t);
    }
  }
}

