import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { OpenclawAgentsService } from '../openclaw-agents/openclaw-agents.service';
import { AgentWorkflow } from './entities/agent-workflow.entity';
import { AgentWorkflowStep } from './entities/agent-workflow-step.entity';
import {
  AgentWorkflowRun,
  AgentWorkflowRunStatus,
  AgentWorkflowRunTrigger,
} from './entities/agent-workflow-run.entity';
import { AgentWorkflowRunStep } from './entities/agent-workflow-run-step.entity';
import { AgentWorkflowRunStepStatus } from './entities/agent-workflow-run-step.entity';
import {
  CreateAgentWorkflowDto,
  ReplaceAgentWorkflowStepsDto,
  UpdateAgentWorkflowDto,
  AgentWorkflowStepInputDto,
} from './dto/agent-workflow.dto';
import { AgentWorkflowQueueService } from './agent-workflow-queue.service';

@Injectable()
export class AgentWorkflowsService {
  constructor(
    @InjectRepository(AgentWorkflow)
    private readonly wfRepo: Repository<AgentWorkflow>,
    @InjectRepository(AgentWorkflowStep)
    private readonly wfStepRepo: Repository<AgentWorkflowStep>,
    @InjectRepository(AgentWorkflowRun)
    private readonly runRepo: Repository<AgentWorkflowRun>,
    @InjectRepository(AgentWorkflowRunStep)
    private readonly runStepRepo: Repository<AgentWorkflowRunStep>,
    private readonly agentsService: OpenclawAgentsService,
    private readonly workflowQueue: AgentWorkflowQueueService,
  ) {}

  async create(
    ownerUserId: number,
    dto: CreateAgentWorkflowDto,
  ): Promise<AgentWorkflow> {
    if (!dto.name?.trim()) {
      throw new BadRequestException('name là bắt buộc.');
    }
    if (!Array.isArray(dto.steps) || !dto.steps.length) {
      throw new BadRequestException('Workflow cần ít nhất một bước (steps).');
    }
    const steps = this.sortSteps(dto.steps);
    if (!steps.length) {
      throw new BadRequestException('Workflow cần ít nhất một bước.');
    }
    await this.assertStepsOwnedByUser(ownerUserId, steps);

    const wf = this.wfRepo.create({
      ownerUserId,
      name: dto.name.trim(),
      description: dto.description?.trim() ?? null,
      enabled: dto.enabled ?? true,
      cronExpression: dto.cronExpression?.trim() || null,
      cronEnabled: dto.cronEnabled ?? false,
    });
    const saved = await this.wfRepo.save(wf);
    await this.persistSteps(saved.id, steps);
    return this.findOneForOwner(saved.id, ownerUserId);
  }

  async update(
    id: number,
    ownerUserId: number,
    dto: UpdateAgentWorkflowDto,
  ): Promise<AgentWorkflow> {
    const wf = await this.requireOwnedWorkflow(id, ownerUserId);
    if (dto.name !== undefined) wf.name = dto.name.trim();
    if (dto.description !== undefined) {
      wf.description = dto.description?.trim() ?? null;
    }
    if (dto.enabled !== undefined) wf.enabled = dto.enabled;
    if (dto.cronExpression !== undefined) {
      wf.cronExpression = dto.cronExpression?.trim() || null;
    }
    if (dto.cronEnabled !== undefined) wf.cronEnabled = dto.cronEnabled;
    await this.wfRepo.save(wf);
    return this.findOneForOwner(id, ownerUserId);
  }

  async replaceSteps(
    id: number,
    ownerUserId: number,
    dto: ReplaceAgentWorkflowStepsDto,
  ): Promise<AgentWorkflow> {
    await this.requireOwnedWorkflow(id, ownerUserId);
    if (!Array.isArray(dto.steps) || !dto.steps.length) {
      throw new BadRequestException('Workflow cần ít nhất một bước (steps).');
    }
    const steps = this.sortSteps(dto.steps);
    if (!steps.length) {
      throw new BadRequestException('Workflow cần ít nhất một bước.');
    }
    await this.assertStepsOwnedByUser(ownerUserId, steps);
    await this.wfStepRepo.delete({ workflowId: id });
    await this.persistSteps(id, steps);
    return this.findOneForOwner(id, ownerUserId);
  }

  async list(ownerUserId: number): Promise<AgentWorkflow[]> {
    return this.wfRepo.find({
      where: { ownerUserId },
      order: { id: 'ASC' },
      relations: ['steps'],
    });
  }

  async findOneForOwner(id: number, ownerUserId: number): Promise<AgentWorkflow> {
    const wf = await this.wfRepo.findOne({
      where: { id, ownerUserId },
      relations: ['steps'],
    });
    if (!wf) {
      throw new NotFoundException('Workflow không tồn tại.');
    }
    if (wf.steps?.length) {
      wf.steps.sort((a, b) => a.stepOrder - b.stepOrder);
    }
    return wf;
  }

  async enqueueRunForUser(
    workflowId: number,
    ownerUserId: number,
  ): Promise<{ runId: string }> {
    const wf = await this.wfRepo.findOne({
      where: { id: workflowId, ownerUserId },
    });
    if (!wf) {
      throw new NotFoundException('Workflow không tồn tại.');
    }
    if (!wf.enabled) {
      throw new BadRequestException('Workflow đang tắt (enabled=false).');
    }
    return this.createRunAndEnqueue(wf.id, ownerUserId, AgentWorkflowRunTrigger.MANUAL);
  }

  /** Gọi từ cron — không kiểm tra user, chỉ workflow enabled. */
  async enqueueRunFromCron(workflowId: number): Promise<{ runId: string } | null> {
    const wf = await this.wfRepo.findOne({ where: { id: workflowId } });
    if (!wf || !wf.enabled || !wf.cronEnabled) {
      return null;
    }
    return this.createRunAndEnqueue(
      wf.id,
      wf.ownerUserId,
      AgentWorkflowRunTrigger.CRON,
    );
  }

  async listRuns(
    ownerUserId: number,
    workflowId?: number,
  ): Promise<AgentWorkflowRun[]> {
    const where: { ownerUserId: number; workflowId?: number } = {
      ownerUserId,
    };
    if (workflowId !== undefined) {
      const wf = await this.wfRepo.findOne({
        where: { id: workflowId, ownerUserId },
      });
      if (!wf) {
        throw new NotFoundException('Workflow không tồn tại.');
      }
      where.workflowId = workflowId;
    }
    return this.runRepo.find({
      where,
      order: { createdAt: 'DESC' },
      take: 200,
    });
  }

  async getRunForOwner(
    runId: string,
    ownerUserId: number,
  ): Promise<AgentWorkflowRun> {
    const run = await this.runRepo.findOne({
      where: { id: runId, ownerUserId },
      relations: ['workflow', 'steps'],
    });
    if (!run) {
      throw new NotFoundException('Không tìm thấy lần chạy.');
    }
    if (run.steps?.length) {
      run.steps.sort((a, b) => a.stepIndex - b.stepIndex);
    }
    return run;
  }

  private async requireOwnedWorkflow(
    id: number,
    ownerUserId: number,
  ): Promise<AgentWorkflow> {
    const wf = await this.wfRepo.findOne({ where: { id, ownerUserId } });
    if (!wf) {
      throw new NotFoundException('Workflow không tồn tại.');
    }
    return wf;
  }

  private sortSteps(steps: AgentWorkflowStepInputDto[]): AgentWorkflowStepInputDto[] {
    return [...steps].sort((a, b) => a.stepOrder - b.stepOrder);
  }

  private async assertStepsOwnedByUser(
    ownerUserId: number,
    steps: AgentWorkflowStepInputDto[],
  ): Promise<void> {
    for (const s of steps) {
      const agent = await this.agentsService.findAgentForOwner(
        s.oaId,
        ownerUserId,
      );
      if (!agent) {
        throw new ForbiddenException(
          `OpenClaw oa_id=${s.oaId} không thuộc tài khoản hoặc không tồn tại.`,
        );
      }
    }
  }

  private async persistSteps(
    workflowId: number,
    steps: AgentWorkflowStepInputDto[],
  ): Promise<void> {
    let order = 0;
    for (const s of steps) {
      const row = this.wfStepRepo.create({
        workflowId,
        stepOrder: order,
        agentId: s.oaId,
        inputText: s.inputText,
      });
      await this.wfStepRepo.save(row);
      order++;
    }
  }

  private async createRunAndEnqueue(
    workflowId: number,
    ownerUserId: number,
    trigger: AgentWorkflowRunTrigger,
  ): Promise<{ runId: string }> {
    const defSteps = await this.wfStepRepo.find({
      where: { workflowId },
      order: { stepOrder: 'ASC' },
    });
    if (!defSteps.length) {
      throw new BadRequestException('Workflow chưa có bước (steps).');
    }

    const runId = uuidv4();
    const run = this.runRepo.create({
      id: runId,
      workflowId,
      ownerUserId,
      status: AgentWorkflowRunStatus.PENDING,
      trigger,
      currentStep: 0,
    });
    await this.runRepo.save(run);

    let idx = 0;
    for (const s of defSteps) {
      const row = this.runStepRepo.create({
        id: uuidv4(),
        runId,
        stepIndex: idx,
        agentId: s.agentId,
        status: AgentWorkflowRunStepStatus.PENDING,
        inputSnapshot: s.inputText,
      });
      await this.runStepRepo.save(row);
      idx++;
    }

    try {
      await this.workflowQueue.enqueueRun(runId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.runRepo.update(runId, {
        status: AgentWorkflowRunStatus.FAILED,
        error: `Queue error: ${msg}`.slice(0, 8000),
        finishedAt: new Date(),
      });
      throw new ServiceUnavailableException(
        'Không đưa được job vào hàng đợi (Redis/BullMQ). Kiểm tra REDIS_*.',
      );
    }

    return { runId };
  }
}
