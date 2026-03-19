import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
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
    action: {
      type: 'string',
      enum: ['list', 'add', 'remove', 'status'],
      description: 'Action to perform on cron jobs',
    },
    jobId: { type: 'string', description: 'Job ID for add/remove actions' },
    cronExpression: {
      type: 'string',
      description: 'Cron expression (e.g. "0 */5 * * *" for every 5 hours)',
    },
    description: { type: 'string', description: 'Description of what the cron job does' },
  },
  required: ['action'],
};

@RegisterSkill({
  code: 'cron_manage',
  name: 'Cron Job Manager',
  description:
    'Manage scheduled cron jobs in the system. ' +
    'Can list existing jobs, add new scheduled tasks, remove jobs, or check status. ' +
    'Uses NestJS SchedulerRegistry under the hood.',
  category: SkillCategory.RUNTIME,
  parametersSchema: PARAMETERS_SCHEMA,
  ownerOnly: true,
})
@Injectable()
export class CronManageSkill implements ISkillRunner {
  private readonly logger = new Logger(CronManageSkill.name);

  constructor(private readonly schedulerRegistry: SchedulerRegistry) {}

  get definition(): ISkillDefinition {
    return {
      code: 'cron_manage',
      name: 'Cron Job Manager',
      description: 'Manage scheduled cron jobs',
      category: SkillCategory.RUNTIME,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
      ownerOnly: true,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const { action } = context.parameters;

    try {
      switch (action) {
        case 'list':
        case 'status': {
          const cronJobs = this.schedulerRegistry.getCronJobs();
          const intervals = this.schedulerRegistry.getIntervals();
          const timeouts = this.schedulerRegistry.getTimeouts();

          const jobs: any[] = [];
          cronJobs.forEach((job, name) => {
            jobs.push({
              name,
              type: 'cron',
              running: job.running,
              lastDate: job.lastDate(),
              nextDate: job.nextDate()?.toISO(),
            });
          });

          return {
            success: true,
            data: {
              cronJobs: jobs,
              intervalCount: intervals.length,
              timeoutCount: timeouts.length,
            },
            metadata: { durationMs: Date.now() - start },
          };
        }
        default:
          return {
            success: false,
            error: `Action "${action}" not yet implemented`,
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
}
