import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenclawAgent } from './entities/openclaw-agent.entity';

/**
 * HTTP relay tới shim trước OpenClaw Gateway (WS control plane upstream).
 * Hợp đồng mặc định: POST JSON { message, sessionKey } → { reply, sessionKey }.
 */
@Injectable()
export class OpenclawRelayHttpService {
  private readonly logger = new Logger(OpenclawRelayHttpService.name);

  constructor(private readonly configService: ConfigService) {}

  async sendChat(params: {
    agent: OpenclawAgent;
    message: string;
    sessionKey: string | null;
  }): Promise<{ reply: string; sessionKey: string | null }> {
    const { agent, message, sessionKey } = params;

    if (this.configService.get<string>('OPENCLAW_MOCK') === 'true') {
      return {
        reply: `[OpenClaw mock] ${message}`,
        sessionKey: sessionKey ?? 'mock-session',
      };
    }

    const path =
      agent.chatPath?.trim() ||
      this.configService.get<string>('OPENCLAW_DEFAULT_CHAT_PATH', '/openclaw/relay');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const scheme = agent.useTls ? 'https' : 'http';
    const url = `${scheme}://${agent.domain}:${agent.port}${normalizedPath}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (agent.gatewayToken?.trim()) {
      headers.Authorization = `Bearer ${agent.gatewayToken.trim()}`;
    }
    if (agent.gatewayPassword?.trim()) {
      headers['X-OpenClaw-Gateway-Password'] = agent.gatewayPassword.trim();
    }

    const timeoutMs = Number(
      this.configService.get<string>('OPENCLAW_RELAY_TIMEOUT_MS', '120000'),
    );

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message, sessionKey }),
        signal: ac.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        this.logger.warn(`OpenClaw relay HTTP ${res.status} ${url}: ${text.slice(0, 500)}`);
        throw new Error(
          `Gateway trả ${res.status}. Kiểm tra domain/port, oa_chat_path, và relay trước OpenClaw.`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new Error('Relay trả không phải JSON hợp lệ.');
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Relay trả JSON không phải object.');
      }

      const obj = parsed as Record<string, unknown>;
      const reply = obj.reply ?? obj.text ?? obj.message;
      if (typeof reply !== 'string') {
        throw new Error('Relay thiếu trường reply/text/message (string).');
      }

      const nextSession =
        obj.sessionKey === undefined || obj.sessionKey === null
          ? sessionKey
          : String(obj.sessionKey);

      return { reply, sessionKey: nextSession };
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') {
        throw new Error(`Hết thời gian chờ relay OpenClaw (${timeoutMs}ms).`);
      }
      if (err.message?.includes('fetch')) {
        throw new Error(
          `Không kết nối được OpenClaw tại ${url}. Kiểm tra máy chủ, TLS (oa_use_tls), và firewall.`,
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
