import { Logger } from '@nestjs/common';
import { GlobalConfigService } from '../../../modules/global-config/global-config.service';
import {
  ILlmProvider,
  ILlmRequestOptions,
  ILlmResponse,
  IToolCall,
} from '../interfaces/llm-provider.interface';

export interface LocalLlmConfig {
  baseUrl: string;
  apiKey?: string | null;
}

/**
 * Base class cho Ollama / LM Studio — cả hai đều expose OpenAI-compatible API
 * tại `{baseUrl}/v1/chat/completions`.
 *
 * Subclass chỉ cần cung cấp providerId, displayName, và getter config từ DB.
 */
export abstract class LocalLlmProvider implements ILlmProvider {
  protected readonly logger: Logger;
  protected cachedConfig: LocalLlmConfig | null | undefined = undefined; // undefined = not yet loaded

  abstract readonly providerId: string;
  abstract readonly displayName: string;
  /** Local LLM không có danh sách model cố định — accept bất kỳ model nào. */
  readonly supportedModels: string[] = [];

  constructor(protected readonly globalConfigService: GlobalConfigService) {
    this.logger = new Logger(this.constructor.name);
  }

  protected abstract loadConfig(): Promise<LocalLlmConfig | null>;

  async ensureKey(): Promise<LocalLlmConfig | null> {
    if (this.cachedConfig !== undefined) return this.cachedConfig;
    this.cachedConfig = await this.loadConfig();
    if (this.cachedConfig) {
      this.logger.log(
        `${this.displayName} configured — baseUrl: ${this.cachedConfig.baseUrl}`,
      );
    }
    return this.cachedConfig;
  }

  isConfigured(): boolean {
    return !!this.cachedConfig?.baseUrl;
  }

  async chat(options: ILlmRequestOptions): Promise<ILlmResponse> {
    const cfg = await this.ensureKey();
    if (!cfg?.baseUrl) {
      throw new Error(`${this.displayName} chưa được cấu hình baseUrl trong database`);
    }

    const endpoint = `${cfg.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey?.trim()) {
      headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: options.model,
      messages: options.messages.map((m) => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.toolCallId) msg.tool_call_id = m.toolCallId;
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        return msg;
      }),
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
    };

    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (options.toolChoice && options.toolChoice !== 'auto') {
        body.tool_choice = options.toolChoice;
      }
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      this.logger.error(`${this.displayName} API error (${res.status}): ${errText}`);
      throw new Error(`${this.displayName} API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    const message = choice?.message;

    let toolCalls: IToolCall[] | undefined;
    if (message?.tool_calls?.length) {
      toolCalls = message.tool_calls.map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments ?? '{}',
      }));
    }

    const finishReason =
      choice?.finish_reason === 'tool_calls'
        ? 'tool_calls'
        : choice?.finish_reason === 'length'
          ? 'length'
          : 'stop';

    return {
      content: message?.content ?? '',
      toolCalls,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      model: data.model ?? options.model,
      finishReason,
    };
  }
}
