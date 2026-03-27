import { Injectable, Logger, Optional } from '@nestjs/common';
import { RegisterSkill } from '../../decorators/skill.decorator';
import {
  ISkillRunner,
  ISkillDefinition,
  ISkillExecutionContext,
  ISkillResult,
  SkillCategory,
  SkillType,
} from '../../interfaces/skill-runner.interface';
import { VectorizationService } from '../../../learning/vectorization.service';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Semantic search query' },
    maxResults: {
      type: 'number',
      description: 'Maximum results to return',
      default: 5,
    },
    minScore: {
      type: 'number',
      description: 'Minimum similarity score threshold (0-1)',
      default: 0.7,
    },
    threadId: {
      type: 'string',
      description:
        'If set, only search memories from this conversation thread. Omit to search across all threads for the user.',
    },
  },
  required: ['query'],
};

@RegisterSkill({
  code: 'memory_search',
  name: 'Memory Search',
  description:
    'Semantic search over agent memory and past conversations using vector embeddings. ' +
    'Use when the user asks about something discussed previously, or when you need ' +
    'context from past interactions to give a better answer.',
  category: SkillCategory.MEMORY,
  parametersSchema: PARAMETERS_SCHEMA,
})
@Injectable()
export class MemorySearchSkill implements ISkillRunner {
  private readonly logger = new Logger(MemorySearchSkill.name);

  constructor(
    @Optional() private readonly vectorization?: VectorizationService,
  ) {}

  get definition(): ISkillDefinition {
    return {
      code: 'memory_search',
      name: 'Memory Search',
      description: 'Semantic search over agent memory and past conversations',
      category: SkillCategory.MEMORY,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const {
      query,
      maxResults = 5,
      minScore = 0.7,
      threadId: paramThreadId,
    } = context.parameters as {
      query: string;
      maxResults?: number;
      minScore?: number;
      threadId?: string;
    };
    const userId = context.userId;

    if (!this.vectorization) {
      return {
        success: false,
        error:
          'VectorizationService not available. LearningModule may not be loaded.',
        data: { query },
        metadata: { durationMs: Date.now() - start },
      };
    }

    try {
      const threadId =
        typeof paramThreadId === 'string' && paramThreadId.trim()
          ? paramThreadId.trim()
          : undefined;

      const results = await this.vectorization.search(userId, query, {
        maxResults,
        minScore,
        ...(threadId ? { threadId } : {}),
      });

      if (results.length === 0) {
        return {
          success: true,
          data: {
            query,
            results: [],
            message: 'No relevant memories found for this query.',
          },
          metadata: { durationMs: Date.now() - start },
        };
      }

      return {
        success: true,
        data: {
          query,
          results: results.map((r) => ({
            content: r.content,
            role: r.role,
            score: Math.round(r.score * 1000) / 1000,
            date: r.createdAt,
            threadId: r.threadId,
          })),
          totalFound: results.length,
        },
        metadata: { durationMs: Date.now() - start },
      };
    } catch (error) {
      this.logger.error(`Memory search failed: ${error.message}`, error.stack);
      return {
        success: false,
        error: `Memory search failed: ${error.message}`,
        data: { query },
        metadata: { durationMs: Date.now() - start },
      };
    }
  }
}
