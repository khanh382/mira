import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OpenclawChatService } from '../openclaw-agents/openclaw-chat.service';
import { OpenclawAgentsService } from '../openclaw-agents/openclaw-agents.service';
import {
  AgentWorkflowRun,
  AgentWorkflowRunStatus,
} from './entities/agent-workflow-run.entity';
import { AgentWorkflowRunStep } from './entities/agent-workflow-run-step.entity';
import { AgentWorkflowRunStepStatus } from './entities/agent-workflow-run-step.entity';

function interpolateInput(template: string, previousOutput: string): string {
  return template.replace(/\{\{\s*previous\s*\}\}/gi, previousOutput);
}

@Injectable()
export class AgentWorkflowExecutorService {
  private readonly logger = new Logger(AgentWorkflowExecutorService.name);

  constructor(
    private readonly openclawChat: OpenclawChatService,
    private readonly agentsService: OpenclawAgentsService,
    @InjectRepository(AgentWorkflowRun)
    private readonly runRepo: Repository<AgentWorkflowRun>,
    @InjectRepository(AgentWorkflowRunStep)
    private readonly runStepRepo: Repository<AgentWorkflowRunStep>,
  ) {}

  /**
   * Thực thi một lần chạy: lỗi OpenClaw từng bước không throw ra ngoài — chỉ ghi DB và dừng chuỗi.
   * Job processor bọc thêm try/catch cho lỗi DB/hệ thống.
   */
  async executeRun(runId: string): Promise<void> {
    const run = await this.runRepo.findOne({
      where: { id: runId },
    });
    if (!run) {
      this.logger.warn(`Workflow run not found: ${runId}`);
      return;
    }

    if (run.status === AgentWorkflowRunStatus.COMPLETED) {
      return;
    }

    if (run.status === AgentWorkflowRunStatus.FAILED) {
      return;
    }

    const now = new Date();
    await this.runRepo.update(runId, {
      status: AgentWorkflowRunStatus.RUNNING,
      startedAt: run.startedAt ?? now,
      error: null,
    });
    await this.patchOrchestrationContext(runId, {
      phase: 'running',
      startedAt: new Date().toISOString(),
    });

    const steps = await this.runStepRepo.find({
      where: { runId },
      order: { stepIndex: 'ASC' },
    });

    let previousOutput = '';
    let lastOutcomeSummary = '';

    for (const stepRow of steps) {
      if (stepRow.status === AgentWorkflowRunStepStatus.COMPLETED) {
        previousOutput = stepRow.output ?? '';
        lastOutcomeSummary = previousOutput.slice(0, 4000);
        continue;
      }
      if (stepRow.status === AgentWorkflowRunStepStatus.FAILED) {
        return;
      }

      const inputText = interpolateInput(stepRow.inputSnapshot, previousOutput);

      const agent = await this.agentsService.findAgentForOwner(
        stepRow.agentId,
        run.ownerUserId,
      );
      if (!agent) {
        await this.failStep(
          runId,
          stepRow.id,
          stepRow.stepIndex,
          inputText,
          `Không tìm thấy OpenClaw agent oa_id=${stepRow.agentId} cho user.`,
          null,
        );
        return;
      }

      await this.runStepRepo.update(stepRow.id, {
        status: AgentWorkflowRunStepStatus.RUNNING,
        startedAt: new Date(),
        error: null,
        oaNameSnapshot: agent.name,
        oaExpertiseSnapshot: agent.expertise ?? null,
      });
      await this.runRepo.update(runId, {
        currentStep: stepRow.stepIndex,
      });

      let result: { ok: boolean; reply: string };
      try {
        result = await this.openclawChat.invokeRelayForWorkflowRun({
          ownerUid: run.ownerUserId,
          runId: run.id,
          oaId: stepRow.agentId,
          inputText,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(
          `Unexpected error in workflow step run=${runId} step=${stepRow.stepIndex}: ${msg}`,
        );
        await this.failStep(
          runId,
          stepRow.id,
          stepRow.stepIndex,
          inputText,
          msg,
          agent,
        );
        return;
      }

      if (!result.ok) {
        await this.failStep(
          runId,
          stepRow.id,
          stepRow.stepIndex,
          inputText,
          result.reply,
          agent,
        );
        return;
      }

      await this.runStepRepo.update(stepRow.id, {
        status: AgentWorkflowRunStepStatus.COMPLETED,
        inputSnapshot: inputText,
        output: result.reply,
        oaNameSnapshot: agent.name,
        oaExpertiseSnapshot: agent.expertise ?? null,
        finishedAt: new Date(),
      });
      previousOutput = result.reply;
      lastOutcomeSummary = result.reply.slice(0, 4000);
      await this.patchOrchestrationContext(runId, {
        lastCompletedStepIndex: stepRow.stepIndex,
        lastOaId: stepRow.agentId,
        lastOutputPreview: result.reply.slice(0, 500),
        updatedAt: new Date().toISOString(),
      });
    }

    await this.runRepo.update(runId, {
      status: AgentWorkflowRunStatus.COMPLETED,
      finishedAt: new Date(),
      currentStep: steps.length ? steps[steps.length - 1]!.stepIndex : 0,
      error: null,
      summary: lastOutcomeSummary || null,
    });
    await this.patchOrchestrationContext(runId, {
      phase: 'completed',
      completedAt: new Date().toISOString(),
    });
  }

  async markRunSystemFailure(runId: string, message: string): Promise<void> {
    const trimmed = message.slice(0, 8000);
    await this.runRepo.update(runId, {
      status: AgentWorkflowRunStatus.FAILED,
      error: trimmed,
      finishedAt: new Date(),
      summary: trimmed.slice(0, 4000),
    });
    await this.patchOrchestrationContext(runId, {
      phase: 'failed',
      reason: 'system',
      error: trimmed.slice(0, 500),
      failedAt: new Date().toISOString(),
    });
  }

  private async failStep(
    runId: string,
    stepId: string,
    stepIndex: number,
    inputText: string,
    errMsg: string,
    agent: { name: string; expertise: string | null } | null,
  ): Promise<void> {
    const trimmed = errMsg.slice(0, 8000);
    await this.runStepRepo.update(stepId, {
      status: AgentWorkflowRunStepStatus.FAILED,
      inputSnapshot: inputText,
      error: trimmed,
      oaNameSnapshot: agent?.name ?? null,
      oaExpertiseSnapshot: agent?.expertise ?? null,
      finishedAt: new Date(),
    });
    await this.runRepo.update(runId, {
      status: AgentWorkflowRunStatus.FAILED,
      error: trimmed,
      finishedAt: new Date(),
      summary: trimmed.slice(0, 4000),
    });
    await this.patchOrchestrationContext(runId, {
      phase: 'failed',
      reason: 'step',
      failedStepIndex: stepIndex,
      error: trimmed.slice(0, 500),
      failedAt: new Date().toISOString(),
    });
  }

  /** Gộp vào `context.orchestration` — chỗ “nhớ tạm” cấp run khi điều phối. */
  private async patchOrchestrationContext(
    runId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const row = await this.runRepo.findOne({
      where: { id: runId },
      select: ['id', 'context'],
    });
    const prev = (row?.context ?? {}) as Record<string, unknown>;
    const prevOrch =
      typeof prev['orchestration'] === 'object' &&
      prev['orchestration'] !== null &&
      !Array.isArray(prev['orchestration'])
        ? (prev['orchestration'] as Record<string, unknown>)
        : {};
    const next: Record<string, unknown> = {
      ...prev,
      orchestration: {
        ...prevOrch,
        ...patch,
      },
    };
    await this.runRepo.update(runId, {
      context: next as Record<string, unknown>,
    });
  }
}
