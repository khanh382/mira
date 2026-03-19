import { Injectable, Logger } from '@nestjs/common';
import { RegisterSkill } from '../../decorators/skill.decorator';
import { ChatService } from '../../../../modules/chat/chat.service';
import {
  ISkillRunner,
  ISkillDefinition,
  ISkillExecutionContext,
  ISkillResult,
  SkillCategory,
  SkillType,
} from '../../interfaces/skill-runner.interface';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    threadId: { type: 'string', description: 'Thread ID (UUID) to fetch history for' },
    limit: { type: 'number', description: 'Max messages to return', default: 20 },
    includeTools: {
      type: 'boolean',
      description: 'Include tool-role messages in output',
      default: false,
    },
  },
  required: ['threadId'],
};

@RegisterSkill({
  code: 'thread_history',
  name: 'Thread History',
  description:
    'Fetch message history for a specific chat thread. ' +
    'Use to review past conversation context or retrieve information discussed earlier.',
  category: SkillCategory.SESSIONS,
  parametersSchema: PARAMETERS_SCHEMA,
})
@Injectable()
export class SessionsHistorySkill implements ISkillRunner {
  private readonly logger = new Logger(SessionsHistorySkill.name);

  constructor(private readonly chatService: ChatService) {}

  get definition(): ISkillDefinition {
    return {
      code: 'thread_history',
      name: 'Thread History',
      description: 'Fetch message history for a chat thread',
      category: SkillCategory.SESSIONS,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const { threadId, limit = 20, includeTools = false } = context.parameters;

    try {
      let messages = await this.chatService.findByThreadId(
        threadId as string,
        limit as number,
      );

      if (!includeTools) {
        messages = messages.filter((m) => m.role !== 'tool');
      }

      return {
        success: true,
        data: {
          threadId,
          messageCount: messages.length,
          messages: messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content.slice(0, 2000),
            tokensUsed: m.tokensUsed,
            createdAt: m.createdAt,
          })),
        },
        metadata: { durationMs: Date.now() - start },
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        metadata: { durationMs: Date.now() - start },
      };
    }
  }
}
