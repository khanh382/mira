import { Injectable, Logger } from '@nestjs/common';
import { RegisterSkill } from '../../decorators/skill.decorator';
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
    query: { type: 'string', description: 'Semantic search query' },
    maxResults: { type: 'number', description: 'Maximum results to return', default: 5 },
    minScore: {
      type: 'number',
      description: 'Minimum similarity score threshold (0-1)',
      default: 0.7,
    },
    collection: {
      type: 'string',
      description: 'Vector collection to search in',
      default: 'chat_messages',
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
    const { query, maxResults = 5, minScore = 0.7, collection } = context.parameters;

    // TODO: Integrate with Vector DB (Qdrant, Milvus, pgvector)
    // 1. Embed query string → vector
    // 2. Search vector DB for nearest neighbors
    // 3. Return matched documents with scores
    return {
      success: false,
      error:
        'Vector DB not yet configured. ' +
        'Integrate Qdrant, Milvus, or pgvector for semantic memory search.',
      data: { query, maxResults, minScore, collection },
      metadata: { durationMs: Date.now() - start },
    };
  }
}
