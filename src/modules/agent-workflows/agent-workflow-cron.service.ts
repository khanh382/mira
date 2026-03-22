import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Interval } from '@nestjs/schedule';
import { AgentWorkflow } from './entities/agent-workflow.entity';
import { AgentWorkflowsService } from './agent-workflows.service';
import { shouldFireCron } from './workflow-cron.util';

@Injectable()
export class AgentWorkflowCronService {
  private readonly logger = new Logger(AgentWorkflowCronService.name);

  constructor(
    @InjectRepository(AgentWorkflow)
    private readonly wfRepo: Repository<AgentWorkflow>,
    private readonly workflowsService: AgentWorkflowsService,
  ) {}

  @Interval(60_000)
  async tickCronWorkflows(): Promise<void> {
    const list = await this.wfRepo.find({
      where: { enabled: true, cronEnabled: true },
    });
    for (const w of list) {
      const expr = w.cronExpression?.trim();
      if (!expr) continue;
      if (!shouldFireCron(expr, w.lastCronAt)) continue;
      try {
        const r = await this.workflowsService.enqueueRunFromCron(w.id);
        if (r) {
          await this.wfRepo.update(w.id, { lastCronAt: new Date() });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Cron enqueue failed wf_id=${w.id}: ${msg}`);
      }
    }
  }
}
