import { Injectable, Logger } from '@nestjs/common';
import { HooksService } from '../../hooks/hooks.service';
import {
  InternalHookEvent,
  PluginHookName,
} from '../../hooks/enums/hook-events.enum';
import {
  IPipelineContext,
  PipelineStage,
} from '../interfaces/pipeline-context.interface';

@Injectable()
export class ReceiveStep {
  private readonly logger = new Logger(ReceiveStep.name);

  constructor(private readonly hooksService: HooksService) {}

  async execute(context: IPipelineContext): Promise<IPipelineContext> {
    this.logger.debug(
      `[${context.runId}] Receiving message from ${context.sourceChannelId}`,
    );

    await this.hooksService.emitInternal(InternalHookEvent.MESSAGE_RECEIVED, {
      sessionKey: `thread:${context.threadId}`,
      userId: context.userId,
      context: {
        channelId: context.sourceChannelId,
        content: context.inboundMessage.content,
      },
    });

    const hookContext = await this.hooksService.executePluginHook(
      PluginHookName.MESSAGE_RECEIVED,
      {
        channelId: context.sourceChannelId,
        content: context.inboundMessage.content,
        userId: context.userId,
        threadId: context.threadId,
      },
    );

    context.processedContent =
      hookContext.content ?? context.inboundMessage.content;
    context.stage = PipelineStage.RECEIVED;

    return context;
  }
}
