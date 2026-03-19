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
import { ModelTier } from '../../../pipeline/model-router/model-tier.enum';
import {
  ScheduledTasksService,
} from '../../../scheduler/scheduled-tasks.service';
import { TaskSource } from '../../../scheduler/entities/scheduled-task.entity';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'remove', 'pause', 'resume', 'status', 'set_global_rules'],
      description:
        'Action: list, add, remove, pause, resume, status, set_global_rules (owner only - thiết lập quy tắc chung)',
    },
    taskCode: {
      type: 'string',
      description:
        'Unique task code (for add/remove/pause/resume/status). Use snake_case, e.g. "daily_email_report"',
    },
    name: {
      type: 'string',
      description: 'Human-readable name for the task (required for add)',
    },
    cronExpression: {
      type: 'string',
      description:
        'Cron expression. Examples: "0 7 * * *" (7AM daily), "*/30 * * * *" (every 30 min), "0 0 * * 1" (Monday midnight)',
    },
    prompt: {
      type: 'string',
      description:
        'The instruction/prompt that the agent will execute on each tick. Be specific and actionable.',
    },
    allowedSkills: {
      type: 'array',
      items: { type: 'string' },
      description:
        'List of skill codes this task is allowed to use (e.g. ["google_workspace", "message_send"]). Null = all skills.',
    },
    maxRetries: {
      type: 'number',
      description:
        'Max consecutive failures before auto-pause (default: 3). Set to 0 for no auto-pause.',
      default: 3,
    },
    maxModelTier: {
      type: 'string',
      enum: ['cheap', 'skill', 'processor', 'expert'],
      description:
        'Max model tier allowed for this task (cost control). Default: follow Smart Router.',
    },
    timeoutMs: {
      type: 'number',
      description: 'Timeout per run in milliseconds (default: 120000 = 2 min)',
      default: 120000,
    },
    description: {
      type: 'string',
      description: 'Optional description of what the task does',
    },
    maxRetriesPerTick: {
      type: 'number',
      description:
        '[set_global_rules] Số lần thử lại tối đa trong 1 lượt tick (mặc định 3). Áp dụng cho mọi user.',
    },
    maxConsecutiveFailedTicks: {
      type: 'number',
      description:
        '[set_global_rules] Số lượt tick liên tiếp fail tối đa trước khi tự đóng task (mặc định 3).',
    },
  },
  required: ['action'],
};

@RegisterSkill({
  code: 'cron_manage',
  name: 'Cron Job Manager',
  description:
    'Manage scheduled tasks (cron jobs & heartbeat). ' +
    'Can: list all tasks, add new scheduled task, remove/pause/resume tasks, check status. ' +
    'Each task runs an agent prompt on a cron schedule with retry policy. ' +
    'If a task fails 3 times consecutively, it auto-pauses (owner must resume). ' +
    'Use for: daily reports, periodic email checks, automated social media posts, data sync, etc.',
  category: SkillCategory.RUNTIME,
  parametersSchema: PARAMETERS_SCHEMA,
  ownerOnly: true,
  minModelTier: ModelTier.SKILL,
})
@Injectable()
export class CronManageSkill implements ISkillRunner {
  private readonly logger = new Logger(CronManageSkill.name);

  constructor(
    private readonly scheduledTasksService: ScheduledTasksService,
  ) {}

  get definition(): ISkillDefinition {
    return {
      code: 'cron_manage',
      name: 'Cron Job Manager',
      description: 'Manage scheduled tasks with retry policy and cost control',
      category: SkillCategory.RUNTIME,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
      ownerOnly: true,
      minModelTier: ModelTier.SKILL,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const { action } = context.parameters;

    try {
      switch (action) {
        case 'list':
          return this.handleList(context, start);
        case 'add':
          return this.handleAdd(context, start);
        case 'remove':
          return this.handleRemove(context, start);
        case 'pause':
          return this.handlePause(context, start);
        case 'resume':
          return this.handleResume(context, start);
        case 'status':
          return this.handleStatus(context, start);
        case 'set_global_rules':
          return this.handleSetGlobalRules(context, start);
        default:
          return {
            success: false,
            error: `Unknown action: ${action}`,
            metadata: { durationMs: Date.now() - start },
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
        metadata: { durationMs: Date.now() - start },
      };
    }
  }

  private async handleList(
    context: ISkillExecutionContext,
    start: number,
  ): Promise<ISkillResult> {
    const tasks = await this.scheduledTasksService.findByUser(context.userId);

    return {
      success: true,
      data: {
        count: tasks.length,
        tasks: tasks.map((t) => ({
          code: t.code,
          name: t.name,
          cron: t.cronExpression,
          status: t.status,
          source: t.source,
          consecutiveFailures: t.consecutiveFailures,
          maxRetries: t.maxRetries,
          totalSuccesses: t.totalSuccesses,
          totalFailures: t.totalFailures,
          lastRunAt: t.lastRunAt,
          lastError: t.lastError,
        })),
      },
      metadata: { durationMs: Date.now() - start },
    };
  }

  private async handleAdd(
    context: ISkillExecutionContext,
    start: number,
  ): Promise<ISkillResult> {
    const {
      taskCode,
      name,
      cronExpression,
      prompt,
      allowedSkills,
      maxRetries = 3,
      maxModelTier,
      timeoutMs = 120000,
      description,
    } = context.parameters as any;

    if (!taskCode || !name || !cronExpression || !prompt) {
      return {
        success: false,
        error:
          'Missing required fields: taskCode, name, cronExpression, prompt',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const task = await this.scheduledTasksService.create({
      userId: context.userId,
      code: taskCode,
      name,
      description,
      cronExpression,
      agentPrompt: prompt,
      allowedSkills: allowedSkills ?? null,
      source: TaskSource.AGENT,
      maxRetries,
      maxModelTier: maxModelTier ?? null,
      timeoutMs,
    });

    return {
      success: true,
      data: {
        message: `Task "${task.name}" created and scheduled`,
        code: task.code,
        cron: task.cronExpression,
        maxRetries: task.maxRetries,
        prompt: task.agentPrompt,
      },
      metadata: { durationMs: Date.now() - start },
    };
  }

  private async handleRemove(
    context: ISkillExecutionContext,
    start: number,
  ): Promise<ISkillResult> {
    const { taskCode } = context.parameters as any;
    if (!taskCode) {
      return {
        success: false,
        error: 'taskCode is required',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const task = await this.scheduledTasksService.findByCode(taskCode);
    if (!task) {
      return {
        success: false,
        error: `Task "${taskCode}" not found`,
        metadata: { durationMs: Date.now() - start },
      };
    }

    if (task.userId !== context.userId) {
      return {
        success: false,
        error: 'Cannot remove tasks belonging to other users',
        metadata: { durationMs: Date.now() - start },
      };
    }

    await this.scheduledTasksService.remove(task.id);

    return {
      success: true,
      data: { message: `Task "${taskCode}" removed` },
      metadata: { durationMs: Date.now() - start },
    };
  }

  private async handlePause(
    context: ISkillExecutionContext,
    start: number,
  ): Promise<ISkillResult> {
    const { taskCode } = context.parameters as any;
    const task = await this.findUserTask(taskCode, context.userId);
    if (!task.success) return { ...task, metadata: { durationMs: Date.now() - start } };

    await this.scheduledTasksService.pause((task.data as any).id);

    return {
      success: true,
      data: { message: `Task "${taskCode}" paused` },
      metadata: { durationMs: Date.now() - start },
    };
  }

  private async handleResume(
    context: ISkillExecutionContext,
    start: number,
  ): Promise<ISkillResult> {
    const { taskCode } = context.parameters as any;
    const task = await this.findUserTask(taskCode, context.userId);
    if (!task.success) return { ...task, metadata: { durationMs: Date.now() - start } };

    await this.scheduledTasksService.resume((task.data as any).id);

    return {
      success: true,
      data: {
        message: `Task "${taskCode}" resumed (failure counter reset)`,
      },
      metadata: { durationMs: Date.now() - start },
    };
  }

  private async handleStatus(
    context: ISkillExecutionContext,
    start: number,
  ): Promise<ISkillResult> {
    const { taskCode } = context.parameters as any;
    const task = await this.scheduledTasksService.findByCode(taskCode);
    if (!task) {
      return {
        success: false,
        error: `Task "${taskCode}" not found`,
        metadata: { durationMs: Date.now() - start },
      };
    }

    return {
      success: true,
      data: {
        code: task.code,
        name: task.name,
        description: task.description,
        cron: task.cronExpression,
        status: task.status,
        source: task.source,
        prompt: task.agentPrompt,
        allowedSkills: task.allowedSkills,
        maxRetries: task.maxRetries,
        consecutiveFailures: task.consecutiveFailures,
        totalSuccesses: task.totalSuccesses,
        totalFailures: task.totalFailures,
        maxModelTier: task.maxModelTier,
        timeoutMs: task.timeoutMs,
        lastRunAt: task.lastRunAt,
        lastSuccessAt: task.lastSuccessAt,
        lastError: task.lastError,
        createdAt: task.createdAt,
      },
      metadata: { durationMs: Date.now() - start },
    };
  }

  private async handleSetGlobalRules(
    context: ISkillExecutionContext,
    start: number,
  ): Promise<ISkillResult> {
    const { maxRetriesPerTick, maxConsecutiveFailedTicks } =
      context.parameters as any;

    if (
      (maxRetriesPerTick != null && (maxRetriesPerTick < 1 || maxRetriesPerTick > 10)) ||
      (maxConsecutiveFailedTicks != null &&
        (maxConsecutiveFailedTicks < 1 || maxConsecutiveFailedTicks > 10))
    ) {
      return {
        success: false,
        error:
          'maxRetriesPerTick và maxConsecutiveFailedTicks phải từ 1 đến 10',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const rules = await this.scheduledTasksService.setGlobalRules({
      maxRetriesPerTick,
      maxConsecutiveFailedTicks,
    });

    return {
      success: true,
      data: {
        message:
          'Quy tắc chung đã cập nhật. Áp dụng cho tất cả cron/heartbeat của mọi user.',
        maxRetriesPerTick: rules.maxRetriesPerTick,
        maxConsecutiveFailedTicks: rules.maxConsecutiveFailedTicks,
      },
      metadata: { durationMs: Date.now() - start },
    };
  }

  private async findUserTask(
    taskCode: string,
    userId: number,
  ): Promise<ISkillResult> {
    if (!taskCode) {
      return { success: false, error: 'taskCode is required' };
    }
    const task = await this.scheduledTasksService.findByCode(taskCode);
    if (!task) {
      return { success: false, error: `Task "${taskCode}" not found` };
    }
    if (task.userId !== userId) {
      return {
        success: false,
        error: 'Cannot modify tasks belonging to other users',
      };
    }
    return { success: true, data: { id: task.id } };
  }
}
