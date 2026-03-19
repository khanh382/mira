/**
 * LLM Provider abstraction.
 * Mỗi provider (OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter...)
 * implement interface này để plug vào hệ thống agent.
 */

export interface ILlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: IToolCall[];
}

export interface IToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface IToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ILlmRequestOptions {
  model: string;
  messages: ILlmMessage[];
  tools?: IToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  thinking?: 'low' | 'medium' | 'high';
}

export interface ILlmResponse {
  content: string;
  toolCalls?: IToolCall[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

export interface ILlmStreamChunk {
  content?: string;
  toolCalls?: Partial<IToolCall>[];
  done: boolean;
}

export interface ILlmProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly supportedModels: string[];

  isConfigured(): boolean;

  chat(options: ILlmRequestOptions): Promise<ILlmResponse>;

  chatStream?(
    options: ILlmRequestOptions,
  ): AsyncIterable<ILlmStreamChunk>;
}
