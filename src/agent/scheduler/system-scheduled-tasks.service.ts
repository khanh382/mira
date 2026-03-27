import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { IScheduledTaskRecord } from './interfaces/scheduled-task-record.interface';
import { PipelineService } from '../pipeline/pipeline.service';
import { IInboundMessage } from '../channels/interfaces/channel.interface';

@Injectable()
export class SystemScheduledTasksService {
  constructor(
    @Inject(forwardRef(() => PipelineService))
    private readonly pipelineService: PipelineService,
  ) {}

  async executeTask(task: IScheduledTaskRecord): Promise<{ tokensUsed: number }> {
    if (!task.agentPrompt?.trim()) {
      throw new Error('agentPrompt is required for targetType=agent_prompt');
    }
    const inboundMessage: IInboundMessage = {
      channelId: 'scheduler',
      senderId: String(task.userId),
      content: task.agentPrompt,
      timestamp: new Date(),
    };

    const context = await this.pipelineService.processMessage(inboundMessage, {
      userId: task.userId,
      threadId: `task:${task.code}`,
      skills: task.allowedSkills ?? undefined,
    });

    if (context.error) {
      throw context.error;
    }

    return { tokensUsed: context.tokensUsed ?? 0 };
  }
}
