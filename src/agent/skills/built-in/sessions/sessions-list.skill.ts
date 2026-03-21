import { Injectable, Logger } from '@nestjs/common';
import { RegisterSkill } from '../../decorators/skill.decorator';
import { ThreadsService } from '../../../../modules/chat/threads.service';
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
    includeInactive: {
      type: 'boolean',
      description: 'Include inactive threads',
      default: false,
    },
  },
};

@RegisterSkill({
  code: 'threads_list',
  name: 'List Chat Threads',
  description:
    'List chat threads for the current user. ' +
    'Use to see what conversations are active.',
  category: SkillCategory.SESSIONS,
  parametersSchema: PARAMETERS_SCHEMA,
})
@Injectable()
export class SessionsListSkill implements ISkillRunner {
  private readonly logger = new Logger(SessionsListSkill.name);

  constructor(private readonly threadsService: ThreadsService) {}

  get definition(): ISkillDefinition {
    return {
      code: 'threads_list',
      name: 'List Chat Threads',
      description: 'List chat threads for the current user',
      category: SkillCategory.SESSIONS,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();

    try {
      const includeInactive = context.parameters?.includeInactive ?? false;
      const threads = await this.threadsService.listByUserId(
        context.userId,
        includeInactive as boolean,
      );
      return {
        success: true,
        data: { threads },
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
