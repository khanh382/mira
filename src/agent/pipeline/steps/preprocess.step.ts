import { Injectable, Logger } from '@nestjs/common';
import { HooksService } from '../../hooks/hooks.service';
import { InternalHookEvent, PluginHookName } from '../../hooks/enums/hook-events.enum';
import { IPipelineContext, PipelineStage } from '../interfaces/pipeline-context.interface';

@Injectable()
export class PreprocessStep {
  private readonly logger = new Logger(PreprocessStep.name);

  constructor(private readonly hooksService: HooksService) {}

  async execute(context: IPipelineContext): Promise<IPipelineContext> {
    this.logger.debug(`[${context.runId}] Preprocessing message`);

    if (context.mediaPath || context.mediaUrl) {
      await this.hooksService.emitInternal(
        InternalHookEvent.MESSAGE_TRANSCRIBED,
        {
          sessionKey: `thread:${context.threadId}`,
          context: { transcript: context.transcript },
        },
      );
    }

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
}
