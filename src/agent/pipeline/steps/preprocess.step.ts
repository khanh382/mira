import { Injectable, Logger } from '@nestjs/common';
import { HooksService } from '../../hooks/hooks.service';
import { InternalHookEvent, PluginHookName } from '../../hooks/enums/hook-events.enum';
import { IPipelineContext, PipelineStage } from '../interfaces/pipeline-context.interface';
import { ILlmMessage } from '../../providers/interfaces/llm-provider.interface';
import { ChatService } from '../../../modules/chat/chat.service';
import { UsersService } from '../../../modules/users/users.service';
import { WorkspaceService } from '../../../gateway/workspace/workspace.service';

const HISTORY_LIMIT = 15;

@Injectable()
export class PreprocessStep {
  private readonly logger = new Logger(PreprocessStep.name);

  constructor(
    private readonly hooksService: HooksService,
    private readonly chatService: ChatService,
    private readonly usersService: UsersService,
    private readonly workspaceService: WorkspaceService,
  ) {}

  async execute(context: IPipelineContext): Promise<IPipelineContext> {
    this.logger.debug(`[${context.runId}] Preprocessing message`);

    // ─── 1. Load system context from workspace files ──────
    await this.loadSystemContext(context);

    // ─── 2. Load recent conversation history from DB ──────
    await this.loadConversationHistory(context);

    // ─── 3. Media transcription hook ──────────────────────
    if (context.mediaPath || context.mediaUrl) {
      await this.hooksService.emitInternal(
        InternalHookEvent.MESSAGE_TRANSCRIBED,
        {
          sessionKey: `thread:${context.threadId}`,
          context: { transcript: context.transcript },
        },
      );
    }

    // ─── 4. Plugin hook: BEFORE_PROMPT_BUILD ──────────────
    const preprocessed = await this.hooksService.executePluginHook(
      PluginHookName.BEFORE_PROMPT_BUILD,
      {
        content: context.processedContent,
        transcript: context.transcript,
        userId: context.userId,
        threadId: context.threadId,
      },
    );

    context.processedContent = preprocessed.content ?? context.processedContent;

    await this.hooksService.emitInternal(
      InternalHookEvent.MESSAGE_PREPROCESSED,
      {
        sessionKey: `thread:${context.threadId}`,
        context: { content: context.processedContent },
      },
    );

    context.stage = PipelineStage.PREPROCESSED;
    return context;
  }

  /**
   * Đọc SOUL.md, USER.md, AGENTS.md, MEMORY.md, daily memory
   * từ workspace files → inject làm system message đầu tiên.
   */
  private async loadSystemContext(context: IPipelineContext): Promise<void> {
    try {
      const user = await this.usersService.findById(context.userId);
      if (!user) return;

      const systemContext = this.workspaceService.buildAgentSystemContext(
        user.identifier,
      );

      if (systemContext) {
        context.conversationHistory.unshift({
          role: 'system',
          content: systemContext,
        });

        this.logger.debug(
          `[${context.runId}] System context loaded (${systemContext.length} chars)`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `[${context.runId}] Failed to load system context: ${error.message}`,
      );
    }
  }

  /**
   * Load N tin nhắn gần nhất từ DB (chat_messages) → conversationHistory.
   * Giúp agent nhớ context từ các lượt chat trước trong cùng thread.
   */
  private async loadConversationHistory(
    context: IPipelineContext,
  ): Promise<void> {
    try {
      const recentMessages = await this.chatService.getRecentMessages(
        context.threadId,
        HISTORY_LIMIT,
      );

      if (recentMessages.length === 0) return;

      const sorted = recentMessages.reverse();

      const historyMessages: ILlmMessage[] = sorted
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      context.conversationHistory.push(...historyMessages);

      this.logger.debug(
        `[${context.runId}] Loaded ${historyMessages.length} history messages from thread ${context.threadId}`,
      );
    } catch (error) {
      this.logger.warn(
        `[${context.runId}] Failed to load conversation history: ${error.message}`,
      );
    }
  }
}
