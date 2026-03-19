import { Injectable, Logger } from '@nestjs/common';
import { GlobalConfigService } from '../../../modules/global-config/global-config.service';
import {
  ILlmProvider,
  ILlmRequestOptions,
  ILlmResponse,
  IToolCall,
} from '../interfaces/llm-provider.interface';

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';

@Injectable()
export class OpenRouterProvider implements ILlmProvider {
  private readonly logger = new Logger(OpenRouterProvider.name);
  private cachedKey: string | null = null;

  readonly providerId = 'openrouter';
  readonly displayName = 'OpenRouter';
  readonly supportedModels = [];

  constructor(private readonly globalConfigService: GlobalConfigService) {}

  isConfigured(): boolean {
    return !!this.cachedKey;
  }

  async ensureKey(): Promise<string | null> {
    if (this.cachedKey) return this.cachedKey;
    this.cachedKey = await this.globalConfigService.getApiKey('openrouter');
    return this.cachedKey;
  }

  async chat(options: ILlmRequestOptions): Promise<ILlmResponse> {
    const apiKey = await this.ensureKey();
    if (!apiKey) {
      throw new Error('OpenRouter API key not configured in database');
    }

    const body: Record<string, unknown> = {
      model: options.model,
      messages: options.messages.map((m) => {
        const msg: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
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
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const res = await fetch(OPENROUTER_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://mira-agent.local',
        'X-Title': 'Mira Agent',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      this.logger.error(`OpenRouter API error (${res.status}): ${errorBody}`);
      throw new Error(`OpenRouter API error ${res.status}: ${errorBody.slice(0, 200)}`);
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
