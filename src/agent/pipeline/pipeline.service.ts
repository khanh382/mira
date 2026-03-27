import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { IInboundMessage } from '../channels/interfaces/channel.interface';
import {
  IPipelineContext,
  PipelineStage,
} from './interfaces/pipeline-context.interface';
import { ReceiveStep } from './steps/receive.step';
import { PreprocessStep } from './steps/preprocess.step';
import { RouteStep } from './steps/route.step';
import { AgentRunStep } from './steps/agent-run.step';
import { DeliverStep } from './steps/deliver.step';
import { StopAllService } from '../control/stop-all.service';
import { AgentFeedbackService } from '../feedback/agent-feedback.service';

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    private readonly receiveStep: ReceiveStep,
    private readonly preprocessStep: PreprocessStep,
    private readonly routeStep: RouteStep,
    private readonly agentRunStep: AgentRunStep,
    private readonly deliverStep: DeliverStep,
    private readonly stopAllService: StopAllService,
    private readonly feedback: AgentFeedbackService,
  ) {}

  async processMessage(
    message: IInboundMessage,
    options: {
      userId: number;
      threadId: string;
      actorTelegramId?: string;
      model?: string;
      skills?: string[];
    },
  ): Promise<IPipelineContext> {
    let context: IPipelineContext = {
      runId: uuidv4(),
      stage: PipelineStage.RECEIVED,
      userId: options.userId,
      threadId: options.threadId,
      actorTelegramId: options.actorTelegramId,
      inboundMessage: message,
      sourceChannelId: message.channelId,
      processedContent: message.content,
      mediaPath: message.mediaPath,
      mediaPaths: message.mediaPaths,
      mediaUrl: message.mediaUrl,
      conversationHistory: [],
      model: options.model,
      activeSkills: options.skills,
      startedAt: new Date(),
      metadata: {},
    };

    this.logger.log(
      `[${context.runId}] Pipeline started for user ${options.userId}`,
    );

    try {
      this.assertNotStopped(context);
      context = await this.receiveStep.execute(context);
      this.assertNotStopped(context);
      context = await this.preprocessStep.execute(context);
      this.assertNotStopped(context);
      context = await this.routeStep.execute(context);
      this.assertNotStopped(context);
      context = await this.agentRunStep.execute(context);
      this.assertNotStopped(context);
      context = await this.deliverStep.execute(context);
    } catch (error) {
      const msg = String((error as any)?.message ?? error);
      const isStopAbort =
        msg.includes('STOP ALL') || msg.includes('/stop command');

      if (isStopAbort) {
        // User cancellation should not look like a real error.
        this.logger.warn(
          `[${context.runId}] Pipeline aborted: ${msg}`,
        );
        context.error = undefined;
        context.stage = PipelineStage.FAILED;
      } else {
        this.logger.error(
          `[${context.runId}] Pipeline failed at stage ${context.stage}: ${msg}`,
          (error as any)?.stack,
        );
        context.error = error as any;
        context.stage = PipelineStage.FAILED;
      }
    }

    const durationMs = Date.now() - context.startedAt.getTime();
    this.logger.log(
      `[${context.runId}] Pipeline ${context.stage} in ${durationMs}ms (tokens: ${context.tokensUsed ?? 0})`,
    );

    try {
      await this.feedback.recordPipelineRun(context);
    } catch (e) {
      this.logger.debug(
        `[${context.runId}] Could not record agent run: ${(e as Error).message}`,
      );
    }

    return context;
  }

  private assertNotStopped(context: IPipelineContext): void {
    if (!this.isInteractiveChannel(context.sourceChannelId)) return;
    if (!this.stopAllService.isStoppedForUser(context.userId)) return;
    const state = this.stopAllService.getUserState(context.userId);
    context.metadata['stoppedAt'] = state.stoppedAt?.toISOString();
    context.metadata['stopScope'] = state.scope;
    throw new Error(
      state.scope === 'global'
        ? 'Pipeline aborted by STOP ALL command'
        : 'Pipeline aborted by /stop command for this user',
    );
  }

  private isInteractiveChannel(channelId?: string): boolean {
    if (!channelId) return false;
    return ['webchat', 'telegram', 'discord', 'zalo', 'slack'].includes(
      channelId,
    );
  }
}
