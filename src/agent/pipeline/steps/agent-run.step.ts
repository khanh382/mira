import { Injectable, Logger } from '@nestjs/common';
import { HooksService } from '../../hooks/hooks.service';
import { PluginHookName } from '../../hooks/enums/hook-events.enum';
import { ProvidersService } from '../../providers/providers.service';
import { SkillsService } from '../../skills/skills.service';
import { IPipelineContext, PipelineStage } from '../interfaces/pipeline-context.interface';

@Injectable()
export class AgentRunStep {
  private readonly logger = new Logger(AgentRunStep.name);

  constructor(
    private readonly hooksService: HooksService,
    private readonly providersService: ProvidersService,
    private readonly skillsService: SkillsService,
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
      const llmInput = await this.hooksService.executePluginHook(
        PluginHookName.LLM_INPUT,
        {
          messages: context.conversationHistory,
          model: context.model,
          tools: this.skillsService.getToolDefinitionsForLLM(),
        },
      );

      // TODO: Implement full agent loop:
      // 1. Build messages array from conversationHistory + processedContent
      // 2. Call LLM via providersService.chat()
      // 3. If toolCalls → execute skills → append results → loop
      // 4. Collect final response

      const llmOutput = await this.hooksService.executePluginHook(
        PluginHookName.LLM_OUTPUT,
        {
          content: context.agentResponse,
          tokensUsed: context.tokensUsed,
          model: context.model,
        },
      );

      context.agentResponse = llmOutput.content ?? '';
      context.tokensUsed = llmOutput.tokensUsed ?? 0;
      context.stage = PipelineStage.AGENT_COMPLETED;
    } catch (error) {
      this.logger.error(`Agent run failed: ${error.message}`, error.stack);
      context.error = error;
      context.stage = PipelineStage.FAILED;
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
}
