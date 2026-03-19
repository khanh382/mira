import { Injectable, Logger } from '@nestjs/common';
import { HooksService } from '../../hooks/hooks.service';
import { PluginHookName } from '../../hooks/enums/hook-events.enum';
import { IPipelineContext, PipelineStage } from '../interfaces/pipeline-context.interface';

@Injectable()
export class RouteStep {
  private readonly logger = new Logger(RouteStep.name);

  constructor(private readonly hooksService: HooksService) {}

  async execute(context: IPipelineContext): Promise<IPipelineContext> {
    this.logger.debug(`[${context.runId}] Routing message`);

    const modelContext = await this.hooksService.executePluginHook(
      PluginHookName.BEFORE_MODEL_RESOLVE,
      {
        model: context.model,
        userId: context.userId,
        threadId: context.threadId,
      },
    );
    context.model = modelContext.model ?? context.model;

    context.targetChannelId = context.targetChannelId ?? context.sourceChannelId;
    context.targetId = context.targetId ?? context.inboundMessage.senderId;

    context.stage = PipelineStage.ROUTED;
    return context;
  }
}
