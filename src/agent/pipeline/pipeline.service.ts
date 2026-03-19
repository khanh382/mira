import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { IInboundMessage } from '../channels/interfaces/channel.interface';
import { IPipelineContext, PipelineStage } from './interfaces/pipeline-context.interface';
import { ReceiveStep } from './steps/receive.step';
import { PreprocessStep } from './steps/preprocess.step';
import { RouteStep } from './steps/route.step';
import { AgentRunStep } from './steps/agent-run.step';
import { DeliverStep } from './steps/deliver.step';

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    private readonly receiveStep: ReceiveStep,
    private readonly preprocessStep: PreprocessStep,
    private readonly routeStep: RouteStep,
    private readonly agentRunStep: AgentRunStep,
    private readonly deliverStep: DeliverStep,
  ) {}

  async processMessage(
    message: IInboundMessage,
    options: {
      userId: number;
      threadId: string;
      model?: string;
      skills?: string[];
    },
  ): Promise<IPipelineContext> {
    let context: IPipelineContext = {
      runId: uuidv4(),
      stage: PipelineStage.RECEIVED,
      userId: options.userId,
      threadId: options.threadId,
      inboundMessage: message,
      sourceChannelId: message.channelId,
      processedContent: message.content,
      conversationHistory: [],
      model: options.model ?? 'openai/gpt-4o',
      activeSkills: options.skills,
      startedAt: new Date(),
      metadata: {},
    };

    this.logger.log(`[${context.runId}] Pipeline started for user ${options.userId}`);

    try {
      context = await this.receiveStep.execute(context);
      context = await this.preprocessStep.execute(context);
      context = await this.routeStep.execute(context);
      context = await this.agentRunStep.execute(context);
      context = await this.deliverStep.execute(context);
    } catch (error) {
      this.logger.error(
        `[${context.runId}] Pipeline failed at stage ${context.stage}: ${error.message}`,
        error.stack,
      );
      context.error = error;
      context.stage = PipelineStage.FAILED;
    }

    const durationMs = Date.now() - context.startedAt.getTime();
    this.logger.log(
      `[${context.runId}] Pipeline ${context.stage} in ${durationMs}ms (tokens: ${context.tokensUsed ?? 0})`,
    );

    return context;
  }
}
