import { Injectable, Logger } from '@nestjs/common';
import { RegisterSkill } from '../../decorators/skill.decorator';
import { UsersService } from '../../../../modules/users/users.service';
import { WorkspaceService } from '../../../../gateway/workspace/workspace.service';
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
    from: {
      type: 'number',
      description: 'Start reading from this line number',
    },
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

  constructor(
    private readonly usersService: UsersService,
    private readonly workspaceService: WorkspaceService,
  ) {}

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
    const {
      path: filePath,
      from,
      lines,
    } = context.parameters as {
      path: string;
      from?: number;
      lines?: number;
    };

    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      const user = await this.usersService.findById(context.userId);
      if (!user) {
        return {
          success: false,
          error: 'User not found',
          metadata: { durationMs: Date.now() - start },
        };
      }

      const workspaceDir = this.workspaceService.getUserWorkspaceDir(
        user.identifier,
      );
      const fullPath = path.resolve(workspaceDir, filePath);

      // Security: prevent path traversal outside workspace
      if (
        !fullPath.startsWith(workspaceDir + path.sep) &&
        fullPath !== workspaceDir
      ) {
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
        const startLine = from ?? 0;
        const count = lines ?? allLines.length;
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
