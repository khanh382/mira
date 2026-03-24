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

  isStreamingEnabled(): boolean {
    return this.configService.get<string>('OPENCLAW_ENABLE_STREAM', 'false') === 'true';
  }

  /**
   * Kiểm tra kết nối tới OpenClaw Gateway.
   * Gửi HTTP GET tới base URL (scheme://domain:port) với timeout ngắn.
   * Server phản hồi bất kỳ (kể cả 4xx/5xx) = có thể reach được mạng.
   * Trả ok=true + latencyMs nếu kết nối được, ok=false + error nếu không.
   */
  async pingAgent(agent: OpenclawAgent): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
    const scheme = agent.useTls ? 'https' : 'http';
    const url = `${scheme}://${agent.domain}:${agent.port}`;
    const timeoutMs = 8000;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const start = Date.now();

    try {
      await fetch(url, { method: 'GET', signal: ac.signal });
      return { ok: true, latencyMs: Date.now() - start, error: null };
    } catch (e) {
      const err = e as Error;
      const latencyMs = Date.now() - start;
      if (err.name === 'AbortError') {
        return { ok: false, latencyMs, error: `Hết thời gian chờ (${timeoutMs}ms). Kiểm tra domain/port và firewall.` };
      }
      return {
        ok: false,
        latencyMs,
        error: `Không kết nối được tới ${url}. Kiểm tra máy chủ, TLS (useTls), và firewall.`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

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

  /**
   * Realtime stream qua SSE từ relay OpenClaw.
   * Hợp đồng kỳ vọng:
   * - event: token, data: {"delta":"..."}
   * - event: done,  data: {"reply":"...","sessionKey":"..."}
   *
   * Fallback:
   * - data: {"delta":"..."} hoặc data: {"reply":"...","sessionKey":"..."}
   */
  async sendChatStream(params: {
    agent: OpenclawAgent;
    message: string;
    sessionKey: string | null;
    onDelta: (delta: string) => void;
  }): Promise<{ reply: string; sessionKey: string | null }> {
    const { agent, message, sessionKey, onDelta } = params;

    if (!this.isStreamingEnabled()) {
      return this.sendChat({ agent, message, sessionKey });
    }

    const path =
      this.configService.get<string>('OPENCLAW_STREAM_PATH', '/openclaw/stream');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const scheme = agent.useTls ? 'https' : 'http';
    const url = `${scheme}://${agent.domain}:${agent.port}${normalizedPath}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Connection: 'keep-alive',
      'Cache-Control': 'no-cache',
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
    const decoder = new TextDecoder();

    let aggregate = '';
    let latestSessionKey: string | null = sessionKey;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message, sessionKey }),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        this.logger.warn(`OpenClaw stream HTTP ${res.status} ${url}: ${text.slice(0, 500)}`);
        throw new Error(
          `Stream gateway trả ${res.status}. Kiểm tra domain/port, OPENCLAW_STREAM_PATH và relay.`,
        );
      }

      let buffer = '';
      let eventName = '';

      const flushEvent = (rawData: string) => {
        const payload = rawData.trim();
        if (!payload) return;
        try {
          const obj = JSON.parse(payload) as Record<string, unknown>;
          const delta =
            typeof obj.delta === 'string'
              ? obj.delta
              : typeof obj.token === 'string'
                ? obj.token
                : null;
          if (delta) {
            aggregate += delta;
            onDelta(delta);
          }
          if (typeof obj.reply === 'string') {
            aggregate = obj.reply;
          }
          if (obj.sessionKey !== undefined && obj.sessionKey !== null) {
            latestSessionKey = String(obj.sessionKey);
          }
          return;
        } catch {
          // plain text delta
        }

        // plain string payload
        aggregate += payload;
        onDelta(payload);
      };

      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let idx = buffer.indexOf('\n\n');
        while (idx >= 0) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf('\n\n');

          const lines = rawEvent.split('\n');
          const dataLines: string[] = [];
          eventName = '';

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trim());
            }
          }

          const data = dataLines.join('\n');
          if (!data) continue;
          if (eventName === 'ping') continue;
          flushEvent(data);
        }
      }

      // final tail (non-standard SSE close)
      const tail = buffer.trim();
      if (tail) {
        const cleaned = tail.startsWith('data:') ? tail.slice(5).trim() : tail;
        if (cleaned) flushEvent(cleaned);
      }

      if (!aggregate.trim()) {
        throw new Error('Stream kết thúc nhưng không có nội dung trả về.');
      }

      return { reply: aggregate, sessionKey: latestSessionKey };
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') {
        throw new Error(`Hết thời gian chờ stream OpenClaw (${timeoutMs}ms).`);
      }
      if (err.message?.includes('fetch')) {
        throw new Error(
          `Không kết nối được OpenClaw stream tại ${url}. Kiểm tra máy chủ, TLS và firewall.`,
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
