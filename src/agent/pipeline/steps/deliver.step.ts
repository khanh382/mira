import { Injectable, Logger } from '@nestjs/common';
import { HooksService } from '../../hooks/hooks.service';
import {
  InternalHookEvent,
  PluginHookName,
} from '../../hooks/enums/hook-events.enum';
import { ChannelsService } from '../../channels/channels.service';
import { StopAllService } from '../../control/stop-all.service';
import {
  IPipelineContext,
  PipelineStage,
} from '../interfaces/pipeline-context.interface';

@Injectable()
export class DeliverStep {
  private readonly logger = new Logger(DeliverStep.name);

  constructor(
    private readonly hooksService: HooksService,
    private readonly channelsService: ChannelsService,
    private readonly stopAllService: StopAllService,
  ) {}

  async execute(context: IPipelineContext): Promise<IPipelineContext> {
    // If user requested STOP mid-flight, avoid delivering any further output
    // (prevents "reading old messages" after the stop command).
    if (this.stopAllService.isStoppedForUser(context.userId)) {
      this.logger.warn(
        `[${context.runId}] Skipping delivery because /stop is active`,
      );
      context.agentResponse = undefined;
      context.stage = PipelineStage.AGENT_COMPLETED;
      return context;
    }

    if (context.stage === PipelineStage.FAILED || !context.agentResponse) {
      this.logger.warn(
        `[${context.runId}] Skipping delivery (stage: ${context.stage})`,
      );
      return context;
    }

    this.logger.debug(
      `[${context.runId}] Delivering response via ${context.targetChannelId}`,
    );

    const sendingContext = await this.hooksService.executePluginHook(
      PluginHookName.MESSAGE_SENDING,
      {
        channelId: context.targetChannelId,
        targetId: context.targetId,
        content: context.agentResponse,
      },
    );

    const channel = this.channelsService.getChannel(context.targetChannelId);
    if (channel) {
      await channel.sendMessage({
        channelId: context.targetChannelId,
        targetId: context.targetId,
        content: sendingContext.content ?? context.agentResponse,
      });
    }

    await this.hooksService.emitInternal(InternalHookEvent.MESSAGE_SENT, {
      sessionKey: `thread:${context.threadId}`,
      userId: context.userId,
      context: {
        channelId: context.targetChannelId,
        content: context.agentResponse,
      },
    });

    await this.hooksService.executeVoidPluginHook(PluginHookName.MESSAGE_SENT, {
      channelId: context.targetChannelId,
      content: context.agentResponse,
    });

    context.stage = PipelineStage.DELIVERED;
    context.completedAt = new Date();

    return context;
  }
}
