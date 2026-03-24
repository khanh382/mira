import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { HooksService } from '../../hooks/hooks.service';
import { PluginHookName } from '../../hooks/enums/hook-events.enum';
import { ProvidersService } from '../../providers/providers.service';
import { SkillsService } from '../../skills/skills.service';
import { ModelRouterService } from '../model-router/model-router.service';
import {
  IPipelineContext,
  PipelineStage,
} from '../interfaces/pipeline-context.interface';
import { IntentType, ModelTier } from '../model-router/model-tier.enum';
import {
  ILlmMessage,
  IToolCall,
} from '../../providers/interfaces/llm-provider.interface';
import { StopAllService } from '../../control/stop-all.service';
import { UsersService } from '../../../modules/users/users.service';
import { UserLevel } from '../../../modules/users/entities/user.entity';
import {
  TaskMemoryService,
  TASK_MEMORY_ASK_USER_AFTER_FAILED_STREAK,
} from '../../../gateway/workspace/task-memory.service';
import { getSharedSkillsPathMentionRegex } from '../../../config/brain-dir.config';
import { IToolDefinitionForLLM } from '../../skills/interfaces/skill-runner.interface';
import { isColleagueSafeTool } from '../../skills/tool-safety.config';

/** Chỉ colleague: đếm lỗi theo (tool + tham số), in-memory trong 1 lượt agent. Owner không áp dụng. */
const COLLEAGUE_PARAM_CIRCUIT_KEY = 'colleagueParamCircuitBreaker';

interface ColleagueParamCircuitState {
  failedActions: Record<string, number>;
}

const BIG_DATA_THRESHOLD = 50_000;
/** Giới hạn độ dài nội dung tool đưa vào history LLM (tránh vỡ context 64k/128k). */
const MAX_TOOL_MESSAGE_CHARS = 48_000;
const MAX_TOOL_ITERATIONS = 15;
const MAX_RETRIES_PER_MODEL = 2;

interface ToolCallRecord {
  skillCode: string;
  result: unknown;
  dataSize: number;
  durationMs: number;
}

function serializeToolResultForLlm(result: unknown): string {
  const raw =
    typeof result === 'string' ? result : JSON.stringify(result ?? null);
  if (raw.length <= MAX_TOOL_MESSAGE_CHARS) return raw;
  const head = raw.slice(0, MAX_TOOL_MESSAGE_CHARS);
  const dropped = raw.length - MAX_TOOL_MESSAGE_CHARS;
  return (
    head +
    `\n\n[…truncated ${dropped} chars — full payload quá lớn cho context LLM; ` +
    `dùng action browser nhẹ (screenshot) hoặc selector hẹp, tránh snapshot HTML full page.]`
  );
}

@Injectable()
export class AgentRunStep {
  private readonly logger = new Logger(AgentRunStep.name);
  /**
   * Natural tool behavior (OpenClaw-like):
   * do not force tool_choice=required or strict follow-up tool calls.
   */
  private readonly naturalToolBehavior = true;

  constructor(
    private readonly hooksService: HooksService,
    private readonly providersService: ProvidersService,
    private readonly skillsService: SkillsService,
    private readonly modelRouter: ModelRouterService,
    private readonly stopAllService: StopAllService,
    private readonly usersService: UsersService,
    private readonly taskMemoryService: TaskMemoryService,
  ) {}

  async execute(context: IPipelineContext): Promise<IPipelineContext> {
    this.logger.debug(
      `[${context.runId}] Running agent with model: ${context.model}`,
    );
    context.stage = PipelineStage.AGENT_RUNNING;

    await this.hooksService.executeVoidPluginHook(
      PluginHookName.BEFORE_AGENT_START,
      {
        userId: context.userId,
        threadId: context.threadId,
        model: context.model,
      },
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

    await this.taskMemoryService.recordAfterAgentRun(context);

    await this.hooksService.executeVoidPluginHook(PluginHookName.AGENT_END, {
      userId: context.userId,
      threadId: context.threadId,
      tokensUsed: context.tokensUsed,
    });

    await this.hooksService.executeVoidPluginHook(PluginHookName.SESSION_END, {
      threadId: context.threadId,
      userId: context.userId,
    });

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

    const toolUser = await this.usersService.findById(context.userId);
    context.metadata['pipelineUserLevel'] = toolUser?.level;

    let tools: IToolDefinitionForLLM[];

    if (toolUser?.level === UserLevel.CLIENT) {
      tools = [];
    } else {
      const ownerOnlyExcluded = toolUser?.level !== UserLevel.OWNER;
      tools = this.skillsService.getToolDefinitionsForLLM({
        excludeOwnerOnly: ownerOnlyExcluded,
      });

      // User gõ rõ `/web_search` hoặc `/tool_web_search` (Telegram/chat) — ưu tiên đúng lệnh, không để
      // model chọn `image_understand` chỉ vì có ảnh đính kèm (vision có thể chưa bật).
      const pcForTools = context.processedContent ?? '';
      const explicitSlashWebSearch =
        /\/web_search\b/i.test(pcForTools) ||
        /\/tool_web_search\b/i.test(pcForTools);
      if (explicitSlashWebSearch && tools.some((t) => t.name === 'web_search')) {
        tools = tools.filter((t) => t.name === 'web_search');
      }

      // Tool-choice: browser vs web_search mơ hồ → mặc định web_search; chỉ hỏi user khi
      // task memory có failedRunStreak >= ngưỡng (cùng vấn đề đã thử đủ mà vẫn lỗi).
      const tm = context.metadata['taskMemory'] as
        | { mode?: string; failedRunStreak?: number }
        | undefined;
      const toolChoice = this.resolveAmbiguousWebToolChoice(
        context.processedContent,
        tools,
        {
          taskMemoryActive: tm?.mode === 'active',
          failedRunStreak: tm?.failedRunStreak ?? 0,
        },
      );
      if (toolChoice?.action === 'ask') {
        context.agentResponse = toolChoice.message;
        context.tokensUsed = 0;
        return;
      }
      if (toolChoice?.action === 'narrow') {
        tools = tools.filter((t) =>
          toolChoice.toolNames.includes(t.name),
        );
      }

      if (toolUser?.level === UserLevel.COLLEAGUE) {
        tools = tools.filter((t) => isColleagueSafeTool(t.name));
      }
    }

    // Combine current user message + selected history to detect intent on confirmation turns.
    //
    // IMPORTANT: Do NOT always include recent history, otherwise keywords from old turns
    // (e.g. "thùng rác/xóa vĩnh viễn") can incorrectly steer the model for unrelated
    // new requests (e.g. "search thời tiết").
    const recentHistoryText = context.conversationHistory
      .slice(-8)
      .map((m) => m.content)
      .join('\n');

    const currentHasDeletionTrigger = /(\bxóa\b|\bxoa\b|\bdelete\b|\bremove\b|\brm\b|thùng\s*rác|thung\s*rac|trash|permanent|vĩnh\s*viễn|vinh\s*vien|empty\s*trash|emptytrash|empty\s*trash|dọn\s*rác|don\s*rac|dọn\s*sạch|don\s*sach)/i.test(
      context.processedContent || '',
    );

    context.metadata['intentText'] = currentHasDeletionTrigger
      ? [context.processedContent, recentHistoryText].filter(Boolean).join('\n')
      : (context.processedContent ?? '');

    if (toolUser?.level === UserLevel.COLLEAGUE) {
      context.metadata[COLLEAGUE_PARAM_CIRCUIT_KEY] = {
        failedActions: {},
      } satisfies ColleagueParamCircuitState;
    }

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      this.throwIfStopped(context);
      this.logger.debug(
        `[${context.runId}] Loop iteration ${iteration + 1}, model=${currentModel}`,
      );

      // ─── Hook: LLM_INPUT ──────────────────────────────────
      const llmInput = await this.hooksService.executePluginHook(
        PluginHookName.LLM_INPUT,
        { messages, model: currentModel, tools },
      );

      // ─── Call LLM ─────────────────────────────────────────
      let llmResponse = await this.callLlmWithRetry(
        currentModel,
        llmInput.messages ?? messages,
        llmInput.tools ?? tools,
        context,
      );

      totalTokens += llmResponse.usage?.totalTokens ?? 0;

      // Một số model (vd. DeepSeek qua OpenRouter) hay trả lời text giả lệnh thay vì gọi tool.
      // Nếu heuristic thấy user đang yêu cầu hành động thật → nhắc + tool_choice=required (OpenRouter).
      const toolList = llmInput.tools ?? tools;
      const noToolCalls =
        llmResponse.finishReason !== 'tool_calls' ||
        !llmResponse.toolCalls?.length;
      const intentText =
        (context.metadata['intentText'] as string | undefined) ??
        context.processedContent;
      const isDriveDeletionIntent =
        this.isLikelyDrivePermanentDeletionIntent(intentText);
      const isSkillsRegistryIntent = this.isLikelySkillsRegistryIntent(
        context.processedContent,
      );
      const isBrowserDebugCleanupIntent =
        this.isLikelyBrowserDebugCleanupIntent(context.processedContent);
      /** After run_skill/bootstrap failure, next turn must call skills_registry_manage again. */
      const strictSkillsRegistryToolNext =
        context.metadata['strictSkillsRegistryToolNext'] === true;
      if (
        !this.naturalToolBehavior &&
        noToolCalls &&
        // Allow nudging on the second loop as well.
        // Otherwise: model can call tool once (e.g. "sheets create") and then stop
        // without calling the follow-up tool (e.g. "sheets update").
        // `strictSkillsRegistryToolNext`: follow-up after bootstrap/run failure can land on iter ≥ 2.
        (iteration <= 1 || strictSkillsRegistryToolNext) &&
        toolList.length > 0 &&
        (this.heuristicLikelyNeedsToolExecution(context.processedContent) ||
          isDriveDeletionIntent ||
          isSkillsRegistryIntent ||
          isBrowserDebugCleanupIntent ||
          strictSkillsRegistryToolNext)
      ) {
        const isGoogleAuthIntent = this.isLikelyGoogleAuthSetupIntent(
          context.processedContent,
        );
        const isWeatherSearchIntent = this.isLikelyWeatherSearchIntent(
          context.processedContent,
        );
        const driveDeletionError =
          'Chưa thể thực hiện xóa vĩnh viễn/dọn thùng rác vì agent chưa gọi tool `google_workspace` (vui lòng thử lại).';
        this.logger.warn(
          `[${context.runId}] Model replied without tool_calls but message looks action-oriented; ` +
            `nudging + tool_choice=required` +
            (strictSkillsRegistryToolNext ? ' (strict: skills_registry_manage only)' : ''),
        );
        const firstReply = llmResponse;
        const workMessages = llmInput.messages ?? messages;
        workMessages.push({
          role: 'user',
          content:
            '[Hệ thống — chỉ cho agent] User đang yêu cầu thao tác thật (Google/Sheets/shell/CLI…). ' +
            'Bạn PHẢI gọi ít nhất một function tool có sẵn. ' +
            (strictSkillsRegistryToolNext
              ? 'Kết quả `skills_registry_manage` vừa rồi CẦN bước tiếp — CHỈ được gọi tool `skills_registry_manage`: ' +
                '`action=run_skill` (thử lại) hoặc `bootstrap_skill` + confirmCreate + draftGroupId từ skillTune + overwriteExisting nếu cần. ' +
                'Không được trả lời user bằng văn bản dài khi chưa gọi tool. '
              : '') +
            (isSkillsRegistryIntent
              ? 'Chạy/thực thi/sử dụng skill → `action=run_skill` + skillCode + runtimeParams. ' +
                'Tạo/ghi đè package → `bootstrap_skill` + confirmCreate; nếu thư mục đã có → `overwriteExisting=true`. ' +
                'Không bootstrap khi user chỉ muốn chạy. Xem PROCESSES.md. CẤM khẳng định "đã lưu" nếu chưa có tool thành công. '
              : isBrowserDebugCleanupIntent
                ? 'Với xóa file nháp/debug browser: BẮT BUỘC gọi `browser_debug_cleanup` (deleteAll=true để xóa hết). '
                : '') +
            (isBrowserDebugCleanupIntent
              ? ''
              : isGoogleAuthIntent
                ? 'Với ý định kết nối/auth Google: BẮT BUỘC gọi `google_auth_setup`. '
                : isDriveDeletionIntent
                  ? 'Với ý định xóa vĩnh viễn/dọn thùng rác (Drive): BẮT BUỘC gọi `google_workspace`. '
                  : 'Ưu tiên `google_workspace` cho thao tác Google; `exec` cho shell khi phù hợp. ') +
            'Không được viết lệnh giả hay hứa "đang chạy" nếu chưa gọi tool.',
        });
        try {
          const filteredTools = strictSkillsRegistryToolNext
            ? toolList.filter((t) => t.name === 'skills_registry_manage')
            : isBrowserDebugCleanupIntent
              ? toolList.filter((t) => t.name === 'browser_debug_cleanup')
              : isGoogleAuthIntent
                ? toolList.filter((t) => t.name === 'google_auth_setup')
                : isDriveDeletionIntent
                  ? toolList.filter((t) => t.name === 'google_workspace')
                  : isWeatherSearchIntent
                    ? toolList.filter(
                        (t) => t.name === 'web_search' || t.name === 'browser',
                      )
                    : toolList;
          const toolsForNudge =
            filteredTools.length > 0 ? filteredTools : toolList;
          llmResponse = await this.callLlmWithRetry(
            currentModel,
            workMessages,
            toolsForNudge,
            context,
            { toolChoice: 'required' },
          );
          totalTokens += llmResponse.usage?.totalTokens ?? 0;
          const stillNoTools =
            llmResponse.finishReason !== 'tool_calls' ||
            !llmResponse.toolCalls?.length;
          if (stillNoTools) {
            this.logger.error(
              `[${context.runId}] tool_choice=required still returned no tool_calls;`,
            );
            if (strictSkillsRegistryToolNext) {
              workMessages.push({
                role: 'user',
                content:
                  '[Hệ thống — chỉ cho agent] Lần 2 (bắt buộc): CHỈ gọi function `skills_registry_manage` với đủ tham số JSON (run_skill hoặc bootstrap_skill). Không trả lời văn bản.',
              });
              try {
                llmResponse = await this.callLlmWithRetry(
                  currentModel,
                  workMessages,
                  toolsForNudge,
                  context,
                  { toolChoice: 'required' },
                );
                totalTokens += llmResponse.usage?.totalTokens ?? 0;
                const stillNoTools2 =
                  llmResponse.finishReason !== 'tool_calls' ||
                  !llmResponse.toolCalls?.length;
                if (!stillNoTools2) {
                  this.logger.log(
                    `[${context.runId}] strict registry follow-up: 2nd tool_choice attempt succeeded`,
                  );
                } else {
                  this.logger.error(
                    `[${context.runId}] strict registry: 2nd tool_choice attempt also returned no tool_calls`,
                  );
                  workMessages.pop();
                  workMessages.pop();
                  llmResponse = {
                    ...firstReply,
                    content: firstReply.content,
                    toolCalls: undefined,
                    finishReason: 'no_tool_calls',
                  } as any;
                }
              } catch (err2: any) {
                this.logger.warn(
                  `[${context.runId}] strict registry 2nd attempt failed: ${err2?.message ?? err2}`,
                );
                workMessages.pop();
                workMessages.pop();
                llmResponse = {
                  ...firstReply,
                  content: firstReply.content,
                  toolCalls: undefined,
                  finishReason: 'no_tool_calls',
                } as any;
              }
            } else {
              workMessages.pop();
              llmResponse = {
                ...firstReply,
                content: isDriveDeletionIntent
                  ? driveDeletionError
                  : firstReply.content,
                toolCalls: undefined,
                finishReason: 'no_tool_calls',
              } as any;
            }
          }
        } catch (err: any) {
          this.logger.warn(
            `[${context.runId}] Forced tool_choice retry failed: ${err?.message ?? err}; using first reply`,
          );
          workMessages.pop();
          llmResponse = {
            ...firstReply,
            content: isDriveDeletionIntent
              ? driveDeletionError
              : firstReply.content,
            toolCalls: undefined,
            finishReason: 'no_tool_calls',
          } as any;
        }
      }

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
        const textOut = llmOutput.content ?? llmResponse.content ?? '';
        if (!this.naturalToolBehavior) {
          const explicitExecCommand = this.extractExplicitExecCommand(
            context.processedContent,
          );
          const hasExecTool = (llmInput.tools ?? tools).some(
            (t) => t.name === 'exec',
          );
          if (explicitExecCommand && hasExecTool) {
            this.logger.warn(
              `[${context.runId}] No tool_calls; fallback to explicit exec command.`,
            );
            const fallbackToolCall: IToolCall = {
              id: `fallback_exec_${Date.now()}`,
              name: 'exec',
              arguments: JSON.stringify({ command: explicitExecCommand }),
            };
            messages.push({
              role: 'assistant',
              content: '',
              toolCalls: [fallbackToolCall],
            });
            const { skillCode, result, record } = await this.executeToolCall(
              fallbackToolCall,
              context,
            );
            allToolCalls.push(record);
            const toolContent = serializeToolResultForLlm(result);
            messages.push({
              role: 'tool',
              toolCallId: fallbackToolCall.id,
              content: toolContent,
            });
            continue;
          }
        }
        if (!this.naturalToolBehavior) {
          const recovered =
            await this.tryRecoverSimulatedSkillsRegistryFromAssistantText(
              context,
              {
                assistantMessage: textOut,
                messages,
                allToolCalls,
                currentModel,
                iteration,
              },
            );
          if (recovered.ok) {
            currentModel = recovered.currentModel;
            continue;
          }
        }
        context.agentResponse = textOut;
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
        this.throwIfStopped(context);
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

        // Thêm tool result vào messages cho LLM iteration tiếp (cắt bớt nếu quá dài)
        const fullRaw =
          typeof result === 'string'
            ? result
            : JSON.stringify(result ?? null);
        const toolContent = serializeToolResultForLlm(result);
        if (toolContent.length < fullRaw.length) {
          this.logger.warn(
            `[${context.runId}] Tool ${skillCode} result truncated for LLM context (${MAX_TOOL_MESSAGE_CHARS} chars cap)`,
          );
        }
        messages.push({
          role: 'tool',
          content: toolContent,
          toolCallId: toolCall.id,
        });

        if (skillCode === 'skills_registry_manage') {
          this.applySkillsRegistryFollowUpAfterToolResult(
            result,
            context,
            messages,
          );
        }

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
      context.agentResponse ??
      'Đã đạt giới hạn số bước xử lý. Vui lòng thử lại với yêu cầu cụ thể hơn.';
    context.tokensUsed = totalTokens;
    context.agentToolCalls = allToolCalls;
  }

  // ─── Tool Execution ──────────────────────────────────────────

  private isSkillToolFailure(result: unknown): boolean {
    if (result == null) return true;
    if (typeof result !== 'object') return true;
    const r = result as {
      success?: boolean;
      metadata?: { timedOut?: boolean };
    };
    if (r.success === true) return false;
    return true;
  }

  /** Chuỗi JSON ổn định (sort key) để băm chữ ký tác vụ. */
  private stableStringifyForSignature(obj: Record<string, unknown>): string {
    const norm = (value: unknown): unknown => {
      if (value === null || value === undefined) return value;
      if (Array.isArray(value)) return value.map(norm);
      if (typeof value === 'object') {
        const o = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(o).sort()) {
          out[k] = norm(o[k]);
        }
        return out;
      }
      return value;
    };
    return JSON.stringify(norm(obj));
  }

  private buildColleagueToolSignature(
    skillCode: string,
    params: Record<string, unknown>,
  ): string {
    const payload = `${skillCode}:${this.stableStringifyForSignature(params)}`;
    return createHash('sha256').update(payload).digest('hex').slice(0, 40);
  }

  /** Gợi ý hiển thị trong báo cáo ngắt mạch (URL, query…). */
  private formatParamHintForCircuitBreaker(
    skillCode: string,
    params: Record<string, unknown>,
  ): string {
    if (skillCode === 'web_fetch' && typeof params.url === 'string') {
      return params.url;
    }
    if (skillCode === 'web_search' && typeof params.query === 'string') {
      return params.query;
    }
    const s = this.stableStringifyForSignature(params);
    return s.length > 220 ? `${s.slice(0, 220)}…` : s;
  }

  private extractExplicitExecCommand(text: string): string | null {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    const oneLine = raw.replace(/\r/g, '');
    const match =
      oneLine.match(/(?:^|[\n:]\s*)exec\s+([^\n]+)/i) ??
      oneLine.match(/^\/exec\s+([^\n]+)/i);
    if (!match?.[1]) return null;
    const command = match[1].trim().replace(/^`+|`+$/g, '');
    return command.length > 0 ? command : null;
  }

  private async executeToolCall(
    toolCall: IToolCall,
    context: IPipelineContext,
  ): Promise<{
    skillCode: string;
    result: unknown;
    record: ToolCallRecord;
  }> {
    const skillCode = String(toolCall.name).trim();
    const start = Date.now();

    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = JSON.parse(toolCall.arguments);
    } catch {
      parsedArgs = {};
    }

    const userLevel = context.metadata['pipelineUserLevel'] as
      | UserLevel
      | undefined;
    const circuit =
      userLevel === UserLevel.COLLEAGUE
        ? (context.metadata[COLLEAGUE_PARAM_CIRCUIT_KEY] as
            | ColleagueParamCircuitState
            | undefined)
        : undefined;

    if (circuit) {
      const signature = this.buildColleagueToolSignature(skillCode, parsedArgs);
      const prev = circuit.failedActions[signature] ?? 0;
      if (prev >= 3) {
        const hint = this.formatParamHintForCircuitBreaker(skillCode, parsedArgs);
        const blockedResult = {
          success: false,
          error:
            `[System Report] Tham số '${hint}' đã bị lỗi kết nối 3 lần liên tiếp. ` +
            `Yêu cầu Agent KHÔNG thử lại tham số này. ` +
            `Hãy đổi sang giá trị khác (ví dụ URL khác như vnexpress) hoặc dùng tool khác.`,
        };
        this.logger.warn(
          `[${context.runId}] Colleague param circuit OPEN (signature=${signature.slice(0, 12)}…)`,
        );
        const serialized = JSON.stringify(blockedResult);
        return {
          skillCode,
          result: blockedResult,
          record: {
            skillCode,
            result: blockedResult,
            dataSize: serialized.length,
            durationMs: Date.now() - start,
          },
        };
      }
    }

    // OpenClaw-like natural behavior: do not block tool execution based on
    // Vietnamese/English intent heuristics at runtime. Let model/tool result decide.

    this.logger.debug(`[${context.runId}] Executing skill: ${skillCode}`);

    let result: unknown;
    try {
      const skillResult = await this.skillsService.executeSkill(skillCode, {
        userId: context.userId,
        threadId: context.threadId,
        runId: context.runId,
        actorTelegramId: context.actorTelegramId,
        parameters: parsedArgs,
      });
      result = skillResult;
    } catch (error: unknown) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (circuit) {
      const signature = this.buildColleagueToolSignature(skillCode, parsedArgs);
      if (!this.isSkillToolFailure(result)) {
        circuit.failedActions[signature] = 0;
      } else {
        const next = (circuit.failedActions[signature] ?? 0) + 1;
        circuit.failedActions[signature] = next;
        if (next >= 3) {
          this.logger.warn(
            `[${context.runId}] Colleague param circuit: 3 failures for signature ${signature.slice(0, 12)}… (next same params will short-circuit)`,
          );
        }
      }
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
    opts?: { toolChoice?: 'auto' | 'none' | 'required' },
  ) {
    let lastError: Error | null = null;
    let currentModel = model;

    for (let attempt = 0; attempt < MAX_RETRIES_PER_MODEL; attempt++) {
      this.throwIfStopped(context);
      try {
        return await this.providersService.chat({
          model: currentModel,
          messages,
          tools,
          toolChoice: opts?.toolChoice,
        });
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `[${context.runId}] LLM call failed (attempt ${attempt + 1}/${MAX_RETRIES_PER_MODEL}): ` +
            `model=${currentModel}, error=${error.message}`,
        );

        if (attempt < MAX_RETRIES_PER_MODEL - 1) {
          const providerFallback = this.resolveProviderModelFallback(
            currentModel,
            error,
          );
          if (providerFallback && providerFallback !== currentModel) {
            this.logger.log(
              `[${context.runId}] Switching model for retry: ${currentModel} → ${providerFallback}`,
            );
            currentModel = providerFallback;
            context.model = currentModel;
            continue;
          }

          if (this.isModelConnectionError(error)) {
            const fallback = await this.modelRouter.resolveEscalationModel(
              context.userId,
            );
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
      const fallback = await this.modelRouter.resolveEscalationModel(
        context.userId,
      );
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
      msg.includes('404') ||
      msg.includes('no endpoints found') ||
      msg.includes('no configured provider')
    );
  }

  private resolveProviderModelFallback(
    currentModel: string,
    error: Error,
  ): string | null {
    const msg = error.message?.toLowerCase() ?? '';

    // OpenRouter may intermittently have unavailable endpoints for some Gemini IDs.
    // Try cheaper/nearby Gemini variants before escalating tier/provider.
    const geminiFallbackChain: Record<string, string> = {
      'openrouter/google/gemini-flash-1.5':
        'openrouter/google/gemini-flash-1.5-8b',
      'openrouter/google/gemini-flash-1.5-8b':
        'openrouter/google/gemini-2.0-flash',
      'openrouter/google/gemini-2.0-flash':
        'openrouter/google/gemini-2.5-flash',
    };

    if (msg.includes('no endpoints found') || msg.includes('404')) {
      return geminiFallbackChain[currentModel] ?? null;
    }

    return null;
  }

  private throwIfStopped(context: IPipelineContext): void {
    if (!this.isInteractiveChannel(context.sourceChannelId)) return;
    if (!this.stopAllService.isStoppedForUser(context.userId)) return;
    const state = this.stopAllService.getUserState(context.userId);
    throw new Error(
      state.scope === 'global'
        ? 'Agent loop aborted by STOP ALL'
        : 'Agent loop aborted by /stop for this user',
    );
  }

  private isInteractiveChannel(channelId?: string): boolean {
    if (!channelId) return false;
    return ['webchat', 'telegram', 'discord', 'zalo', 'slack'].includes(
      channelId,
    );
  }

  /**
   * Heuristic: user message likely needs a real tool run (not free-form text).
   * Dùng để ép model gọi tool khi hay "diễn" lệnh giả (đặc biệt DeepSeek + OpenRouter).
   */
  private heuristicLikelyNeedsToolExecution(text: string): boolean {
    const raw = text.trim().toLowerCase();
    const t = raw.normalize('NFD').replace(/\p{Diacritic}/gu, '');

    const wantsAction =
      raw.includes('tạo') ||
      t.includes('tao ') ||
      // Vietnamese "xóa" (agent trước đây không bắt được nên hay trả lời thủ công)
      t.includes('xoa') ||
      /\b(create|new|make|add|update|delete|send|run|execute|chay|chạy|list|get)\b/.test(
        t,
      ) ||
      /\b(gog|gogcli)\b/i.test(t);

    if (/\b(gog|gogcli)\b/i.test(t)) return true;

    if (
      /\b(google)\s+(sheet|sheets|drive|gmail|doc|docs|calendar|slide|slides)\b/.test(
        t,
      )
    ) {
      return wantsAction;
    }
    if (/\b(spreadsheet|worksheet)\b/.test(t) && wantsAction) return true;
    if ((raw.includes('trang tính') || /trang\s*tinh/.test(t)) && wantsAction)
      return true;
    if (
      wantsAction &&
      /\bsheets?\b/.test(t) &&
      (t.includes('google') || raw.includes('google'))
    ) {
      return true;
    }

    // Google auth / connection intent: force a tool call.
    if (
      (raw.includes('google') || t.includes('google')) &&
      /(khoi dong|ket noi|connect|authenticate|auth|setup|cau hinh|google workspace|console json|credentials json)/.test(
        t,
      )
    ) {
      return true;
    }

    // Nếu user dán trực tiếp redirect URL (remote step2), vẫn ép tool auth.
    if (raw.includes('oauth2/callback')) return true;
    if (
      (t.includes('tao ') || raw.includes('tạo')) &&
      (t.includes('sheet') ||
        raw.includes('trang tính') ||
        t.includes('trang tinh'))
    ) {
      return true;
    }
    if (
      /\b(exec|shell|bash|terminal)\b/.test(t) &&
      /\b(run|chay|chạy|execute)\b/.test(t)
    ) {
      return true;
    }

    // Web/browser/search/weather requests should be executed via tools,
    // otherwise the model may only respond with a "I'll do it" message.
    if (
      /\b(browser|trinh\s*duyet|trinh\s*duy?t|search|tim\s*kiem|mo\s*web|truy\s*c?u)\b/i.test(
        t,
      ) ||
      (t.includes('thoi') && t.includes('tiet')) || // thoi tiet (không dấu)
      t.includes('weather') ||
      t.includes('du bao')
    ) {
      return true;
    }
    // Đăng bài / post Facebook — thường dùng browser + skills_registry (trước đây không khớp keyword → không ép tool).
    if (
      /\b(dang|đăng)\s*b(ai|ài)\b/i.test(raw) ||
      /\bpost\b.{0,30}\bfacebook\b/i.test(raw) ||
      /\bfacebook\b.{0,40}\b(dang|đăng|post|bai|bài|status|tin)\b/i.test(raw)
    ) {
      return true;
    }
    if (this.isLikelySkillsRegistryIntent(raw)) return true;
    return false;
  }

  /** User đang hỏi/chạy skill trong $BRAIN_DIR/_shared/skills/<skill_code>/ (filesystem). */
  private isLikelySkillsRegistryIntent(text: string): boolean {
    const lower = String(text ?? '').toLowerCase();
    const t = lower.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    const mentionsDbContext =
      /\b(skills_registry|skill registry|skills registry)\b/.test(lower) ||
      getSharedSkillsPathMentionRegex().test(lower) ||
      /(trong\s+(db|database|sql)|\bdb\b|database)/i.test(lower) ||
      /(liệt kê|liet ke|danh sách|danh sach).{0,50}\bskill/i.test(lower) ||
      /(skill|skills).{0,40}(trong|trong db|trong database|trong bảng|trong bang|trong thư mục)/i.test(
        lower,
      ) ||
      /có\s+skill\s+nào|co\s+skill\s+nao|skill\s+nào\s+(trong|trong db|trong database)/i.test(
        lower,
      );

    // "sử dụng skill" ≠ "dùng skill" (khác từ) — phải match riêng kẻo model chỉ in JSON, không gọi tool.
    const quotedSkillCode =
      /\bskill\s*["'`]\s*[a-z][a-z0-9_]+\s*["'`]/i.test(lower) ||
      /\bskill\s+[a-z][a-z0-9_]{3,40}_[a-z0-9_]{2,40}\b/i.test(lower);
    const runSkillWithContext =
      /(sử\s*dụng|su\s*dung|thực\s*thi|thuc\s*thi|dùng|dung|chạy|chay|gọi|goi|kích hoạt).{0,60}\bskill/i.test(
        lower,
      ) &&
      (/(trong\s*(db|database)|\bdb\b|database|skills_registry|_shared\/skills)/i.test(
        lower,
      ) ||
        (lower.includes('facebook') && /\bskill\b/i.test(lower)) ||
        /\bfacebook_post_status\b/i.test(lower) ||
        quotedSkillCode);

    // Lưu template / đóng gói skill — model hay bịa "đã lưu" nếu không bắt intent này.
    const wantsPersistOrTemplate =
      /\bskill\b.{0,120}(template|tái\s*sử|tai\s*su|dùng\s*lại|dung\s*lai|đóng\s*gói|dong\s*goi|dùng\s*chung|dung\s*chung|_shared)/i.test(
        lower,
      ) ||
      /(template|tái\s*sử|tai\s*su|dùng\s*lại|dung\s*lai|đóng\s*gói|dong\s*goi).{0,80}\bskill\b/i.test(
        lower,
      ) ||
      /(lưu|luu|tao|tạo).{0,40}(skill|template|package).{0,40}(chung|_shared|shared|dùng\s*lại|dung\s*lai)/i.test(
        lower,
      ) ||
      /(tối\s*ưu|toi\s*u).{0,80}\bskill\b/i.test(lower) ||
      /(tối\s*ưu|toi\s*u).{0,40}(thành|thanh).{0,20}template/i.test(lower) ||
      (/\bbootstrap\b/i.test(lower) && /\bskill\b/i.test(lower)) ||
      // ASCII fallback (user gõ không dấu)
      /\bskill\b.{0,120}\b(template|tai\s*su\s*dung|dung\s*lai|dong\s*goi)\b/i.test(t) ||
      /\b(toi\s*uu|luu\s*skill|tao\s*skill|package\s*skill)\b/i.test(t);

    return mentionsDbContext || runSkillWithContext || wantsPersistOrTemplate;
  }

  /**
   * Kết quả skills_registry_manage cần lượt gọi tool tiếp (run_skill lại / bootstrap / …).
   * Dùng để bật strict nudge + gợi ý trong messages — không phụ thuộc từ khóa tin nhắn user ban đầu.
   */
  private skillsRegistryResultNeedsFollowUpTool(result: unknown): boolean {
    if (result == null || typeof result !== 'object') return false;
    const r = result as Record<string, unknown>;
    if (r.success === false) return true;
    const data = r.data;
    if (!data || typeof data !== 'object') return false;
    const d = data as Record<string, unknown>;
    if (d.skillTune != null) return true;
    if (typeof d.nextStepOnFailure === 'string' && d.nextStepOnFailure.length > 0) {
      return true;
    }
    const run = d.run;
    if (run && typeof run === 'object') {
      const rr = run as Record<string, unknown>;
      if (rr.success === false) return true;
      if (rr.skillTune != null) return true;
    }
    return false;
  }

  /**
   * bootstrap_skill vừa ghi package thành công nhưng user đã yêu cầu chạy skill
   * → lượt sau bắt buộc `run_skill` (tránh model chỉ in JSON giả / "đang thực thi").
   */
  private skillsRegistryBootstrapSuccessNeedsRunSkillFollowUp(
    result: unknown,
    userMessage: string,
  ): boolean {
    if (!this.registryResultIsBootstrapWriteSuccess(result)) return false;
    return this.userMessageImpliesRunSkillIntent(userMessage);
  }

  private registryResultIsBootstrapWriteSuccess(result: unknown): boolean {
    if (result == null || typeof result !== 'object') return false;
    const r = result as Record<string, unknown>;
    if (r.success !== true) return false;
    const data = r.data;
    if (!data || typeof data !== 'object') return false;
    const d = data as Record<string, unknown>;
    const skill = d.skill;
    if (!skill || typeof skill !== 'object') return false;
    const nextStep = d.nextStep;
    if (typeof nextStep !== 'string' || !nextStep.toLowerCase().includes('run_skill')) {
      return false;
    }
    const code = (skill as Record<string, unknown>).code;
    return typeof code === 'string' && code.length > 0;
  }

  /** User muốn thực thi skill (run), không chỉ tạo/ghi package. */
  private userMessageImpliesRunSkillIntent(text: string): boolean {
    const t = (text || '').trim();
    if (!t) return false;
    if (/\b(chạy|thực thi|thực hiện|execute|run)\s+skill\b/i.test(t)) return true;
    if (/\brun_skill\b/i.test(t)) return true;
    // "skill facebook_post_… với nội dung …" (thiếu động từ đầu câu)
    if (/\bskill\s+[\w-]+\s+với\s+(nội dung|content)\b/i.test(t)) return true;
    return false;
  }

  private extractSkillCodeFromBootstrapResult(result: unknown): string | null {
    if (result == null || typeof result !== 'object') return null;
    const data = (result as Record<string, unknown>).data;
    if (!data || typeof data !== 'object') return null;
    const skill = (data as Record<string, unknown>).skill;
    if (!skill || typeof skill !== 'object') return null;
    const code = (skill as Record<string, unknown>).code;
    return typeof code === 'string' && code.length > 0 ? code : null;
  }

  private extractRunSkillRuntimeParamsFromUserMessage(
    text: string,
  ): Record<string, string> {
    const quotedAfterKw = this.extractQuotedTextAfterKeywords(text, [
      'nội dung',
      'noi dung',
      'content',
    ]);
    const fallback =
      quotedAfterKw ??
      (() => {
        const m = text.match(/["']([^"']{2,})["']/);
        return m ? m[1] : null;
      })();
    const out: Record<string, string> = {};
    if (fallback != null && fallback.trim().length > 0) {
      out.content = fallback.trim();
    }
    return out;
  }

  private extractQuotedTextAfterKeywords(
    text: string,
    keywords: string[],
  ): string | null {
    const lower = text.toLowerCase();
    for (const kw of keywords) {
      const idx = lower.indexOf(kw.toLowerCase());
      if (idx < 0) continue;
      const after = text.slice(idx + kw.length);
      const m = after.match(/^\s*[:=]?\s*["']([^"']+)["']/);
      if (m) return m[1];
    }
    return null;
  }

  private buildBootstrapThenRunSkillSystemMessage(
    result: unknown,
    userMessage: string,
  ): string | null {
    const skillCode = this.extractSkillCodeFromBootstrapResult(result);
    if (!skillCode) return null;
    const runtimeParams =
      this.extractRunSkillRuntimeParamsFromUserMessage(userMessage);
    const paramsJson = JSON.stringify(runtimeParams);
    return (
      '[Hệ thống — chỉ cho agent] User đã yêu cầu CHẠY skill (không chỉ ghi package). ' +
      'Bootstrap vừa xong — gọi NGAY `skills_registry_manage` với `action=run_skill`, ' +
      `skillCode="${skillCode}", runtimeParams=${paramsJson}. ` +
      'CẤM trả lời bằng JSON mô phỏng, "đang thực thi", hay hứa hẹn — phải gọi tool thật.'
    );
  }

  /**
   * skills_registry_manage (run_skill/bootstrap) thất bại hoặc có skillTune →
   * lượt sau bắt buộc gọi lại tool (tránh model chỉ trả lời văn bản).
   * bootstrap_skill thành công nhưng user vốn yêu cầu "chạy skill" → vẫn phải run_skill (strict).
   */
  private applySkillsRegistryFollowUpAfterToolResult(
    result: unknown,
    context: IPipelineContext,
    messages: ILlmMessage[],
  ): void {
    if (this.naturalToolBehavior) {
      context.metadata['strictSkillsRegistryToolNext'] = false;
      return;
    }
    const needsFollowUp = this.skillsRegistryResultNeedsFollowUpTool(result);
    const bootstrapNeedsRunSkill =
      this.skillsRegistryBootstrapSuccessNeedsRunSkillFollowUp(
        result,
        context.processedContent ?? '',
      );
    if (needsFollowUp || bootstrapNeedsRunSkill) {
      context.metadata['strictSkillsRegistryToolNext'] = true;
      let followContent =
        '[Hệ thống — chỉ cho agent] Kết quả `skills_registry_manage` vừa rồi cần bước TIẾP THEO bằng tool (không chỉ mô tả cho user). ' +
        'Gọi lại `skills_registry_manage`: nếu có skillTune/draftGroupId → `bootstrap_skill` + confirmCreate + overwriteExisting; ' +
        'nếu chỉ cần thử lại → `run_skill` với cùng skillCode và runtimeParams phù hợp. Đọc JSON tool phía trên.';
      if (bootstrapNeedsRunSkill && !needsFollowUp) {
        const specific = this.buildBootstrapThenRunSkillSystemMessage(
          result,
          context.processedContent ?? '',
        );
        if (specific) followContent = specific;
      }
      messages.push({
        role: 'user',
        content: followContent,
      });
    } else {
      context.metadata['strictSkillsRegistryToolNext'] = false;
    }
  }

  /**
   * Model in khối ```json với `action: run_skill` nhưng không emit tool_calls →
   * parse + thực thi thật, rồi tiếp tục vòng agent (không gửi JSON giả cho user).
   */
  private async tryRecoverSimulatedSkillsRegistryFromAssistantText(
    context: IPipelineContext,
    params: {
      assistantMessage: string;
      messages: ILlmMessage[];
      allToolCalls: ToolCallRecord[];
      currentModel: string;
      iteration: number;
    },
  ): Promise<{ ok: true; currentModel: string } | { ok: false }> {
    const { assistantMessage, messages, allToolCalls, iteration } = params;
    let currentModel = params.currentModel;

    const parsed =
      this.tryParseSkillsRegistryJsonFromAssistantFencedBlock(assistantMessage);
    if (!parsed || String(parsed['action']) !== 'run_skill') {
      return { ok: false };
    }
    const skillCode = String(parsed['skillCode'] ?? '').trim();
    if (!skillCode) {
      return { ok: false };
    }
    if (this.skillRegistryRunSkillAlreadyExecutedInThisRun(allToolCalls, skillCode)) {
      return { ok: false };
    }
    if (!this.assistantTextSuggestsSimulatedSkillsRegistryRun(assistantMessage)) {
      return { ok: false };
    }

    const rp = parsed['runtimeParams'];
    const runtimeParams =
      rp && typeof rp === 'object' && !Array.isArray(rp)
        ? (rp as Record<string, unknown>)
        : {};

    const toolCall: IToolCall = {
      id: `recover-simulated-${context.runId}-${Date.now()}`,
      name: 'skills_registry_manage',
      arguments: JSON.stringify({
        action: 'run_skill',
        skillCode,
        runtimeParams,
      }),
    };

    try {
      this.throwIfStopped(context);
      this.logger.warn(
        `[${context.runId}] Phát hiện JSON mô phỏng run_skill trong câu trả lời (không có tool_calls) — thực thi skills_registry_manage thật.`,
      );
      context.metadata['recoveredSimulatedSkillsRegistryRun'] = true;

      const { result, record } = await this.executeToolCall(toolCall, context);
      allToolCalls.push(record);

      messages.push({
        role: 'assistant',
        content: assistantMessage,
      });
      messages.push({
        role: 'tool',
        content: typeof result === 'string' ? result : JSON.stringify(result),
        toolCallId: toolCall.id,
      });

      this.applySkillsRegistryFollowUpAfterToolResult(result, context, messages);

      currentModel = await this.maybeSwapModel(
        currentModel,
        record,
        context,
        iteration,
      );

      await this.hooksService.executeVoidPluginHook(
        PluginHookName.AFTER_TOOL_CALL,
        {
          userId: context.userId,
          threadId: context.threadId,
          tools: [record],
        },
      );

      return { ok: true, currentModel };
    } catch (err: any) {
      this.logger.warn(
        `[${context.runId}] Không thể khôi phục run_skill từ JSON mô phỏng: ${err?.message ?? err}`,
      );
      return { ok: false };
    }
  }

  /** Lấy object JSON đầu tiên trong fence ```json … ``` nếu có `action`. */
  private tryParseSkillsRegistryJsonFromAssistantFencedBlock(
    text: string,
  ): Record<string, unknown> | null {
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (!m?.[1]) return null;
    const raw = m[1].trim();
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw) as unknown;
      if (
        obj &&
        typeof obj === 'object' &&
        !Array.isArray(obj) &&
        typeof (obj as Record<string, unknown>)['action'] === 'string'
      ) {
        return obj as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /**
   * Tránh chạy nhầm khi model chỉ đưa "ví dụ" tĩnh: cần dấu hiệu đang hứa chạy / fence JSON + run_skill.
   */
  private assistantTextSuggestsSimulatedSkillsRegistryRun(text: string): boolean {
    const t = text || '';
    if (/đang\s+thực\s*thi|dang\s+thuc\s+thi/i.test(t)) return true;
    if (/\*\([^)]*(đang|dang)[^)]*thực/i.test(t)) return true;
    if (
      /\b(sẽ\s+chạy|se\s+chay|chạy\s+lại|chay\s+lai|will\s+run)\b/i.test(t) &&
      /\bskill\b/i.test(t)
    ) {
      return true;
    }
    if (/```(?:json)?/i.test(t) && /\brun_skill\b/i.test(t)) return true;
    return false;
  }

  /** Đã có lần gọi run_skill thật (data.run) cho skillCode trong cùng agent run. */
  private skillRegistryRunSkillAlreadyExecutedInThisRun(
    allToolCalls: ToolCallRecord[],
    skillCode: string,
  ): boolean {
    for (const r of allToolCalls) {
      if (r.skillCode !== 'skills_registry_manage') continue;
      const res = r.result;
      if (res == null || typeof res !== 'object') continue;
      const data = (res as Record<string, unknown>).data;
      if (!data || typeof data !== 'object') continue;
      const d = data as Record<string, unknown>;
      if (d.selectedSkillCode === skillCode && d.run != null) {
        return true;
      }
    }
    return false;
  }

  private isLikelyDrivePermanentDeletionIntent(text: string): boolean {
    const raw = (text || '').toLowerCase();
    // Match drive deletion + permanent + trash.
    return (
      raw.includes('drive') &&
      (raw.includes('thung rac') ||
        raw.includes('trash') ||
        raw.includes('emptytrash') ||
        raw.includes('thùng rác')) &&
      (raw.includes('permanent') ||
        raw.includes('vinh vien') ||
        raw.includes('vĩnh viễn') ||
        raw.includes('delete forever') ||
        raw.includes('xoa vinh vien') ||
        raw.includes('xóa vĩnh viễn'))
    );
  }

  /** User yêu cầu xóa file nháp / debug browser trong $BRAIN_DIR/.../browser_debug. */
  private isLikelyBrowserDebugCleanupIntent(text: string): boolean {
    const raw = (text || '').toLowerCase();
    const t = raw.normalize('NFD').replace(/\p{Diacritic}/gu, '');

    // Chỉ hỏi lệnh / cách / ví dụ — không coi là "yêu cầu thực thi xóa" (tránh ép tool khi naturalToolBehavior=false).
    const wantsHowOrCommand =
      /\b(lenh|lệnh)\b/.test(raw) ||
      /\b(cach|cách)\b/.test(t) ||
      /\b(huong\s*dan|hướng\s*dẫn)\b/.test(t) ||
      /\b(lam\s*sao|làm\s*sao)\b/.test(t) ||
      /\bhow\s*to\b/.test(raw) ||
      /\bsyntax\b/.test(raw) ||
      /\b(vi\s*du|ví\s*dụ)\b/.test(t) ||
      /\b(hoi|hỏi)\s*(lenh|lệnh|cach|cách)\b/.test(t);
    const giveMeCommand =
      /\b(cho\s+anh|cho\s+em|xin|dua|đưa|chi|chỉ)\b/.test(t) &&
      /\b(lenh|lệnh|cach|cách|huong\s*dan|hướng\s*dẫn)\b/.test(raw);
    const explicitExecuteDelete =
      /\b(xoa\s+giup|xóa\s+giúp|don\s+giup|dọn\s+giúp|xoa\s+ho|xóa\s+hộ|goi\s+tool|gọi\s+tool|chay\s+giup|chạy\s+giúp|thuc\s*hien|thực\s*hiện|deleteall|xoa\s+luon|xóa\s+luôn|xoa\s+het|xóa\s+hết|dọn\s+het|don\s+het|dọn\s+luôn|don\s+luon|thực\s*hiện\s*xóa|thuc\s*hien\s*xoa)\b/.test(
        t,
      );
    if ((wantsHowOrCommand || giveMeCommand) && !explicitExecuteDelete) {
      return false;
    }

    const hasDelete = /xóa|xoa|delete|remove|dọn|don|clear|dọn sạch|don sach/i.test(raw);
    const hasBrowserTarget =
      /file\s*nháp|file\s*nhaps|file nháp|browser\s*debug|browser_debug|thư\s*mục\s*browser|thu\s*muc\s*browser|browser\s*folder/i.test(
        raw,
      ) ||
      (/\bbrowser\b/i.test(raw) && (hasDelete || /nháp|nhaps|debug|tạm|tam/i.test(raw)));
    return hasDelete && hasBrowserTarget;
  }

  private isLikelyEmailSendIntent(text: string): boolean {
    const raw = (text || '').toLowerCase();
    if (!raw) return false;
    // Email send requests often include '@' addresses and/or keywords.
    const hasEmailAddress = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text);
    return (
      hasEmailAddress ||
      raw.includes('gửi') && raw.includes('email') ||
      raw.includes('send') && raw.includes('email') ||
      raw.includes('gmail')
    );
  }

  private isLikelyGoogleAuthSetupIntent(text: string): boolean {
    const raw = text.trim().toLowerCase();
    const t = raw.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    if (!raw.includes('google') && !t.includes('google')) return false;
    // Typical phrases for "connect/auth/setup credentials"
    return (
      /(ket noi|khoi dong|connect|authenticate|auth|setup|cau hinh)/.test(
        t,
      ) ||
      t.includes('cloud console') ||
      raw.includes('cloud console') ||
      t.includes('gog auth') ||
      raw.includes('gog auth') ||
      /(console|workspace)/.test(raw) ||
      raw.includes('via gog') ||
      raw.includes('qua gog')
    );
  }

  private isLikelyGoogleWorkspaceIntent(text: string): boolean {
    const raw = (text ?? '').toLowerCase();
    if (!raw) return false;

    const hasDeletionTrigger =
      /(\bxóa\b|\bxoa\b|\bdelete\b|\bremove\b|\brm\b|thùng\s*rác|thung\s*rac|trash|emptytrash|empty\s*trash|empty_trash|permanent|vĩnh\s*viễn|vinh\s*vien|delete forever|xoa vinh vien|xóa vĩnh viễn|dọn\s*rác|don\s*rác|dọn\s*sạch|don\s*sach)/i.test(
        raw,
      );

    const hasGoogleService =
      /\b(google|gogcli|gog\s*auth|gog\s|gog\b|gmail|drive|sheets?|calendar|google\s*workspace|cloud\s*console|workspace)\b/i.test(
        raw,
      );

    const hasEmailKeywords =
      /(\bgửi\s*mail\b|\bgửi\s*email\b|\bsend\s*email\b|\bmail\b.*\b(ngu?c|marketing|crypto|nội\s*dung)?\b|\bgmail\b|\bemail\b)/i.test(
        raw,
      );

    return hasDeletionTrigger || hasGoogleService || hasEmailKeywords;
  }

  // Kept tên hàm để hạn chế đổi chỗ,
  // nhưng thực chất là "web search / browser search intent".
  private isLikelyWeatherSearchIntent(text: string): boolean {
    const raw = (text ?? '').toLowerCase();
    if (!raw) return false;

    // Don't classify destructive requests as web search.
    const hasDeletionTrigger = /(\bxóa\b|\bxoa\b|\bdelete\b|\bremove\b|\brm\b|thùng\s*rác|thung\s*rac|trash|permanent|vĩnh\s*viễn|vinh\s*vien)/i.test(
      raw,
    );
    if (hasDeletionTrigger) return false;

    // If it clearly looks like Google intent, don't treat it as web search.
    if (this.isLikelyGoogleWorkspaceIntent(raw)) return false;

    const hasWeather = /(\bthời\s*tiết\b|\bthoi\s*tiet\b|\bdự\s*báo\b|\bdu\s*bao\b|\bweather\b|\bforecast\b|\bdự\s*báo\b|\bdu\s*bao\b)/i.test(
      raw,
    );

    const hasWebSearch = /(\bsearch\b|\btìm\s*kiếm\b|\btra\s*cứu\b|\btruy\s*cứu\b|\btrình\s*duyệt\b|\btrinh\s*duyet\b|\bbrowser\b|\bmở\s*web\b|\bmo\s*web\b|\blên\s*trình\s*duyệt\b)/i.test(
      raw,
    );

    return hasWeather || hasWebSearch;
  }

  private resolveAmbiguousWebToolChoice(
    text: string,
    tools: Array<{ name?: string }>,
    opts?: { taskMemoryActive?: boolean; failedRunStreak?: number },
  ):
    | { action: 'ask'; message: string }
    | { action: 'narrow'; toolNames: string[] }
    | null {
    const toolNames = new Set(tools.map((t) => t?.name).filter(Boolean) as string[]);

    const hasBrowser = toolNames.has('browser');
    const hasWebSearch = toolNames.has('web_search');
    if (!hasBrowser || !hasWebSearch) return null;

    const raw = (text ?? '').toLowerCase();

    // Only ask/clarify when user intent is actually about web browsing/search.
    // Otherwise we should never block normal tasks like writing content.
    const hasExplicitNoWeb =
      /\b(không|ko)\b.*\b(tra\s*cuu|tra\s*cứu|tìm\s*kiếm|tim\s*kiem|search|browser|trình\s*duyệt|trinh\s*duyet|web)\b/i.test(
        raw,
      );
    if (hasExplicitNoWeb) return null;

    const hasWebIntent =
      /\/web_search\b/.test(raw) ||
      /\/tool_web_search\b/.test(raw) ||
      /\bweb_search\b/.test(raw) ||
      /\b(tra\s*cuu|tra\s*cứu|tìm\s*kiếm|tim\s*kiem|search|web\s*search|browser|trình\s*duyệt|trinh\s*duyet|mở\s*web|mo\s*web|thông\s*tin\s*web|thong\s*tin\s*web)\b/i.test(
        raw,
      ) ||
      /\b(thời\s*tiết|thoi\s*tiet|dự\s*báo|du\s*bao|weather|forecast)\b/i.test(
        raw,
      );

    if (!hasWebIntent) return null;

    const wantsBrowser =
      /\b(browser|trình\s*duyệt|trinh\s*duyet|mở\s*web|mo\s*web)\b/.test(raw) ||
      /(dùng|dung)\s*browser/.test(raw);

    const wantsWebSearch =
      /\/web_search\b/.test(raw) ||
      /\/tool_web_search\b/.test(raw) ||
      /\bweb_search\b/.test(raw) ||
      /\b(web\s*search|websearch|tìm\s*kiếm|tim\s*kiem|search)\b/.test(raw) ||
      /(tìm\s*dùm|tim\s*du?m)/.test(raw);

    // If user explicitly asks for one, narrow accordingly.
    if (wantsBrowser && !wantsWebSearch) {
      return { action: 'narrow', toolNames: ['browser'] };
    }
    if (wantsWebSearch && !wantsBrowser) {
      return { action: 'narrow', toolNames: ['web_search'] };
    }

    const streak = opts?.failedRunStreak ?? 0;
    const mustAskAfterRetries =
      opts?.taskMemoryActive === true &&
      streak >= TASK_MEMORY_ASK_USER_AFTER_FAILED_STREAK;

    // Mặc định mềm: không chặn pipeline — ưu tiên web_search khi còn mơ hồ.
    if (!mustAskAfterRetries) {
      return { action: 'narrow', toolNames: ['web_search'] };
    }

    return {
      action: 'ask',
      message:
        'Sếp muốn em dùng cách nào để tra cứu/thông tin web?\n' +
        '- `browser` (mở trình duyệt) \n' +
        '- `web_search` (tìm kiếm web)\n\n' +
        'Sếp trả lời: `browser` hoặc `search` giúp em ạ.',
    };
  }
}
