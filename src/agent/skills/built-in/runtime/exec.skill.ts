import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { RegisterSkill } from '../../decorators/skill.decorator';
import {
  ISkillRunner,
  ISkillDefinition,
  ISkillExecutionContext,
  ISkillResult,
  SkillCategory,
  SkillType,
} from '../../interfaces/skill-runner.interface';

const execFileAsync = promisify(execFile);

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'Shell command to execute' },
    workdir: { type: 'string', description: 'Working directory' },
    timeout: { type: 'number', description: 'Timeout in milliseconds', default: 30000 },
    env: {
      type: 'object',
      description: 'Additional environment variables',
      additionalProperties: { type: 'string' },
    },
  },
  required: ['command'],
};

@RegisterSkill({
  code: 'exec',
  name: 'Execute Command',
  description:
    'Run a shell command and return its output. ' +
    'Use for file operations, system checks, running scripts, installing packages, ' +
    'git operations, and any task requiring command-line access. ' +
    'Commands run in a sandboxed environment with timeout protection.',
  category: SkillCategory.RUNTIME,
  parametersSchema: PARAMETERS_SCHEMA,
  ownerOnly: true,
})
@Injectable()
export class ExecSkill implements ISkillRunner {
  private readonly logger = new Logger(ExecSkill.name);

  get definition(): ISkillDefinition {
    return {
      code: 'exec',
      name: 'Execute Command',
      description: 'Run a shell command and return its output',
      category: SkillCategory.RUNTIME,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
      ownerOnly: true,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const {
      command,
      workdir,
      timeout = 30000,
      env: extraEnv,
    } = context.parameters;

    try {
      const { stdout, stderr } = await execFileAsync(
        '/bin/bash',
        ['-c', command as string],
        {
          cwd: (workdir as string) || process.cwd(),
          timeout: timeout as number,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, ...(extraEnv as Record<string, string>) },
        },
      );

      return {
        success: true,
        data: {
          stdout: stdout.slice(0, 50000),
          stderr: stderr.slice(0, 10000),
          exitCode: 0,
        },
        metadata: { durationMs: Date.now() - start },
      };
    } catch (error: any) {
      return {
        success: error.code === 0,
        data: {
          stdout: error.stdout?.slice(0, 50000) || '',
          stderr: error.stderr?.slice(0, 10000) || error.message,
          exitCode: error.code ?? 1,
        },
        error: error.killed ? 'Command timed out' : undefined,
        metadata: { durationMs: Date.now() - start },
      };
    }
  }
}
