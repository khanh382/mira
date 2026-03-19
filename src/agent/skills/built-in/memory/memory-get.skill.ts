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
    path: {
      type: 'string',
      description: 'Path to memory file (e.g. "MEMORY.md", "memory/notes.md")',
    },
    from: { type: 'number', description: 'Start reading from this line number' },
    lines: { type: 'number', description: 'Number of lines to read' },
  },
  required: ['path'],
};

@RegisterSkill({
  code: 'memory_get',
  name: 'Memory Get',
  description:
    'Read a specific memory/knowledge file by path. ' +
    'Agent workspace may contain MEMORY.md and other knowledge files. ' +
    'Use to retrieve stored notes, instructions, or reference documents.',
  category: SkillCategory.MEMORY,
  parametersSchema: PARAMETERS_SCHEMA,
})
@Injectable()
export class MemoryGetSkill implements ISkillRunner {
  private readonly logger = new Logger(MemoryGetSkill.name);

  get definition(): ISkillDefinition {
    return {
      code: 'memory_get',
      name: 'Memory Get',
      description: 'Read a specific memory/knowledge file',
      category: SkillCategory.MEMORY,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const { path: filePath, from, lines } = context.parameters;

    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      // TODO: Configure workspace directory
      const workspaceDir = process.env.AGENT_WORKSPACE || process.cwd();
      const fullPath = path.resolve(workspaceDir, filePath as string);

      // Security: prevent path traversal outside workspace
      if (!fullPath.startsWith(workspaceDir)) {
        return {
          success: false,
          error: 'Path traversal not allowed',
          metadata: { durationMs: Date.now() - start },
        };
      }

      const content = await fs.readFile(fullPath, 'utf-8');
      let result = content;

      if (from !== undefined || lines !== undefined) {
        const allLines = content.split('\n');
        const startLine = (from as number) || 0;
        const count = (lines as number) || allLines.length;
        result = allLines.slice(startLine, startLine + count).join('\n');
      }

      return {
        success: true,
        data: { path: filePath, content: result },
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
