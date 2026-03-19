import { Injectable, Logger } from '@nestjs/common';
import { HooksService } from '../../hooks/hooks.service';
import { PluginHookName } from '../../hooks/enums/hook-events.enum';
import { ProvidersService } from '../../providers/providers.service';
import { SkillsService } from '../../skills/skills.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { IPipelineContext, PipelineStage } from '../interfaces/pipeline-context.interface';
import { IntentType, ModelTier } from '../model-router/model-tier.enum';
import { ILlmMessage, IToolCall } from '../../providers/interfaces/llm-provider.interface';

const BIG_DATA_THRESHOLD = 50_000;
const MAX_TOOL_ITERATIONS = 15;
const MAX_RETRIES_PER_MODEL = 2;

interface ToolCallRecord {
  skillCode: string;
  result: unknown;
  dataSize: number;
  durationMs: number;
}

@Injectable()
export class AgentRunStep {
  private readonly logger = new Logger(AgentRunStep.name);

  constructor(
    private readonly hooksService: HooksService,
    private readonly providersService: ProvidersService,
    private readonly skillsService: SkillsService,
    private readonly modelRouter: ModelRouterService,
  ) {}

  async execute(context: IPipelineContext): Promise<IPipelineContext> {
    this.logger.debug(`[${context.runId}] Running agent with model: ${context.model}`);
    context.stage = PipelineStage.AGENT_RUNNING;

    await this.hooksService.executeVoidPluginHook(
      PluginHookName.BEFORE_AGENT_START,
      { userId: context.userId, threadId: context.threadId, model: context.model },
    );

    await this.hooksService.executeVoidPluginHook(
      PluginHookName.SESSION_START,
      { threadId: context.threadId, userId: context.userId },
    );

    try {
      await this.runAgentLoop(context);
      context.stage = PipelineStage.AGENT_COMPLETED;
    } catch (error) {
      this.logger.error(`Agent run failed: ${error.message}`, error.stack);

      if (this.isModelConnectionError(error)) {
        await this.attemptModelFallback(context, error);
      }

      if (!context.agentResponse) {
        context.error = error;
        context.stage = PipelineStage.FAILED;
      }
    }

    await this.hooksService.executeVoidPluginHook(
      PluginHookName.AGENT_END,
      { userId: context.userId, threadId: context.threadId, tokensUsed: context.tokensUsed },
    );

    await this.hooksService.executeVoidPluginHook(
      PluginHookName.SESSION_END,
      { threadId: context.threadId, userId: context.userId },
    );

    return context;
  }

  // ─── Agent Loop (multi-model, multi-tool) ──────────────────────

  private async runAgentLoop(context: IPipelineContext): Promise<void> {
    let currentModel = context.model;
    let totalTokens = 0;
    const allToolCalls: ToolCallRecord[] = [];

    const messages: ILlmMessage[] = [
      ...context.conversationHistory,
      { role: 'user', content: context.processedContent },
    ];

    const tools = this.skillsService.getToolDefinitionsForLLM();

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      this.logger.debug(
        `[${context.runId}] Loop iteration ${iteration + 1}, model=${currentModel}`,
      );

      // ─── Hook: LLM_INPUT ──────────────────────────────────
      const llmInput = await this.hooksService.executePluginHook(
        PluginHookName.LLM_INPUT,
        { messages, model: currentModel, tools },
      );

      // ─── Call LLM ─────────────────────────────────────────
      const llmResponse = await this.callLlmWithRetry(
        currentModel,
        llmInput.messages ?? messages,
        llmInput.tools ?? tools,
        context,
      );

      totalTokens += llmResponse.usage?.totalTokens ?? 0;

      // ─── Hook: LLM_OUTPUT ─────────────────────────────────
      const llmOutput = await this.hooksService.executePluginHook(
        PluginHookName.LLM_OUTPUT,
        {
          content: llmResponse.content,
          toolCalls: llmResponse.toolCalls,
          tokensUsed: totalTokens,
          model: currentModel,
        },
      );

      // ─── Kết thúc: LLM không gọi tool nào ─────────────────
      if (
        llmResponse.finishReason !== 'tool_calls' ||
        !llmResponse.toolCalls?.length
      ) {
        context.agentResponse = llmOutput.content ?? llmResponse.content ?? '';
        context.tokensUsed = totalTokens;
        context.model = currentModel;
        context.agentToolCalls = allToolCalls;
        return;
      }

      // ─── Thêm assistant message (có tool_calls) vào history ─
      messages.push({
        role: 'assistant',
        content: llmResponse.content ?? '',
        toolCalls: llmResponse.toolCalls,
      });

      // ─── Execute từng tool call ────────────────────────────
      for (const toolCall of llmResponse.toolCalls) {
        await this.hooksService.executeVoidPluginHook(
          PluginHookName.BEFORE_TOOL_CALL,
          {
            userId: context.userId,
            threadId: context.threadId,
            skillCode: toolCall.name,
            arguments: toolCall.arguments,
          },
        );

        const { skillCode, result, record } = await this.executeToolCall(
          toolCall,
          context,
        );

        allToolCalls.push(record);

        // Thêm tool result vào messages cho LLM iteration tiếp
        messages.push({
          role: 'tool',
          content: typeof result === 'string' ? result : JSON.stringify(result),
          toolCallId: toolCall.id,
        });

        // ─── Mid-loop model switching ─────────────────────
        currentModel = await this.maybeSwapModel(
          currentModel,
          record,
          context,
          iteration,
        );
      }

      // ─── Hook: AFTER_TOOL_CALL (fire-and-forget per batch) ─
      await this.hooksService.executeVoidPluginHook(
        PluginHookName.AFTER_TOOL_CALL,
        {
          userId: context.userId,
          threadId: context.threadId,
          tools: allToolCalls.slice(-llmResponse.toolCalls.length),
        },
      );
    }

    this.logger.warn(
      `[${context.runId}] Agent loop hit max iterations (${MAX_TOOL_ITERATIONS})`,
    );
    context.agentResponse =
      context.agentResponse ?? 'Đã đạt giới hạn số bước xử lý. Vui lòng thử lại với yêu cầu cụ thể hơn.';
    context.tokensUsed = totalTokens;
    context.agentToolCalls = allToolCalls;
  }

  // ─── Tool Execution ──────────────────────────────────────────

  private async executeToolCall(
    toolCall: IToolCall,
    context: IPipelineContext,
  ): Promise<{
    skillCode: string;
    result: unknown;
    record: ToolCallRecord;
  }> {
    const skillCode = toolCall.name;
    const start = Date.now();

    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = JSON.parse(toolCall.arguments);
    } catch {
      parsedArgs = {};
    }

    this.logger.debug(
      `[${context.runId}] Executing skill: ${skillCode}`,
    );

    let result: unknown;
    try {
      const skillResult = await this.skillsService.executeSkill(skillCode, {
        userId: context.userId,
        threadId: context.threadId,
        parameters: parsedArgs,
      });
      result = skillResult;
    } catch (error) {
      result = { success: false, error: error.message };
    }

    const serialized = JSON.stringify(result);
    const record: ToolCallRecord = {
      skillCode,
      result,
      dataSize: serialized.length,
      durationMs: Date.now() - start,
    };

    this.logger.debug(
      `[${context.runId}] Skill ${skillCode} → ${record.dataSize} chars in ${record.durationMs}ms`,
    );

    return { skillCode, result, record };
  }

  // ─── Mid-Loop Model Switching ─────────────────────────────────

  /**
   * Quyết định có nên đổi model giữa các iteration hay không.
   *
   * Quy tắc:
   * 1. Tool trả về big data (>50K chars) → chuyển sang PROCESSOR (Gemini Flash)
   *    để tóm tắt trước khi LLM chính xử lý tiếp
   * 2. Nếu tool fail liên tiếp (agent đang "mò mẫm") → giữ SKILL tier
   *    vì cần model mạnh để suy luận cách khác
   * 3. Iteration cao (>8) → có thể cần EXPERT tier để chốt kết quả
   * 4. Sau khi xử lý big data xong → quay lại model chính (SKILL tier)
   */
  private async maybeSwapModel(
    currentModel: string,
    lastToolResult: ToolCallRecord,
    context: IPipelineContext,
    iteration: number,
  ): Promise<string> {
    // Big data: tool trả về nhiều dữ liệu → dùng Gemini Flash xử lý
    if (lastToolResult.dataSize > BIG_DATA_THRESHOLD) {
      const processorDecision = await this.modelRouter.resolveProcessorModel(
        lastToolResult.dataSize,
      );
      this.logger.log(
        `[${context.runId}] Big data (${lastToolResult.dataSize} chars) from ${lastToolResult.skillCode} ` +
        `→ switching to PROCESSOR: ${processorDecision.model}`,
      );
      context.metadata['lastProcessorSwitch'] = {
        fromModel: currentModel,
        toModel: processorDecision.model,
        reason: `big data from ${lastToolResult.skillCode}`,
        dataSize: lastToolResult.dataSize,
      };
      return processorDecision.model;
    }

    // Nếu vừa dùng PROCESSOR model (do big data trước đó) → quay lại SKILL model
    const lastSwitch = context.metadata['lastProcessorSwitch'] as any;
    if (lastSwitch && currentModel !== lastSwitch.fromModel) {
      this.logger.log(
        `[${context.runId}] Data processed, returning to main model: ${lastSwitch.fromModel}`,
      );
      context.metadata['lastProcessorSwitch'] = null;
      return lastSwitch.fromModel;
    }

    // Iteration quá cao → escalate lên EXPERT tier
    if (iteration >= 8) {
      const expertDecision = await this.modelRouter.resolveEscalationModel(
        context.userId,
      );
      if (expertDecision.model !== currentModel) {
        this.logger.log(
          `[${context.runId}] High iteration count (${iteration}) → escalating to EXPERT: ${expertDecision.model}`,
        );
        return expertDecision.model;
      }
    }

    return currentModel;
  }

  // ─── LLM Call with Retry ────────────────────────────────────

  private async callLlmWithRetry(
    model: string,
    messages: ILlmMessage[],
    tools: any[],
    context: IPipelineContext,
  ) {
    let lastError: Error | null = null;
    let currentModel = model;

    for (let attempt = 0; attempt < MAX_RETRIES_PER_MODEL; attempt++) {
      try {
        return await this.providersService.chat({
          model: currentModel,
          messages,
          tools,
        });
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `[${context.runId}] LLM call failed (attempt ${attempt + 1}/${MAX_RETRIES_PER_MODEL}): ` +
          `model=${currentModel}, error=${error.message}`,
        );

        if (this.isModelConnectionError(error) && attempt < MAX_RETRIES_PER_MODEL - 1) {
          const fallback = await this.modelRouter.resolveEscalationModel(context.userId);
          if (fallback.model !== currentModel) {
            this.logger.log(
              `[${context.runId}] Switching model for retry: ${currentModel} → ${fallback.model}`,
            );
            currentModel = fallback.model;
            context.model = currentModel;
          }
          continue;
        }
      }
    }

    throw lastError ?? new Error('LLM call failed after all retries');
  }

  // ─── Model Fallback (top-level error) ─────────────────────

  private async attemptModelFallback(
    context: IPipelineContext,
    originalError: Error,
  ): Promise<void> {
    this.logger.warn(
      `[${context.runId}] Model connection error, attempting full fallback loop`,
    );

    try {
      const fallback = await this.modelRouter.resolveEscalationModel(context.userId);
      if (fallback.model !== context.model) {
        this.logger.log(
          `[${context.runId}] Retrying entire agent loop with fallback: ${fallback.model}`,
        );
        context.model = fallback.model;
        context.metadata['modelFallbackAttempt'] = true;
        context.error = undefined;
        await this.runAgentLoop(context);
      }
    } catch (fallbackErr) {
      this.logger.error(
        `[${context.runId}] Fallback also failed: ${fallbackErr.message}`,
      );
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────

  private isModelConnectionError(error: Error): boolean {
    const msg = error.message?.toLowerCase() ?? '';
    return (
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('timeout') ||
      msg.includes('429') ||
      msg.includes('rate limit') ||
      msg.includes('503') ||
      msg.includes('502') ||
      msg.includes('no configured provider')
    );
  }
}
