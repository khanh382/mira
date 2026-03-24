import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TaskRun, TaskRunStatus } from './entities/task-run.entity';
import { TaskRunStep, TaskRunStepStatus } from './entities/task-run-step.entity';
import { TaskStep, StepExecutorType, StepOnFailure } from './entities/task-step.entity';
import { PipelineService } from '../../agent/pipeline/pipeline.service';
import { OpenclawChatService } from '../openclaw-agents/openclaw-chat.service';
import { OpenclawAgentsService } from '../openclaw-agents/openclaw-agents.service';
import { IInboundMessage } from '../../agent/channels/interfaces/channel.interface';

function interpolate(template: string, previous: string): string {
  return template.replace(/\{\{\s*previous\s*\}\}/gi, previous);
}

const HTTP_TOKEN_EXECUTION_POLICY =
  'Dùng token từ http_tokens, không hỏi lại credentials.';

@Injectable()
export class TaskExecutorService {
  private readonly logger = new Logger(TaskExecutorService.name);

  constructor(
    @InjectRepository(TaskRun)
    private readonly runRepo: Repository<TaskRun>,
    @InjectRepository(TaskRunStep)
    private readonly runStepRepo: Repository<TaskRunStep>,
    @InjectRepository(TaskStep)
    private readonly stepDefRepo: Repository<TaskStep>,
    @Inject(forwardRef(() => PipelineService))
    private readonly pipelineService: PipelineService,
    private readonly openclawChat: OpenclawChatService,
    private readonly openclawAgents: OpenclawAgentsService,
  ) {}

  async executeRun(runId: string): Promise<void> {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) {
      this.logger.warn(`Task run not found: ${runId}`);
      return;
    }
    if (
      run.status === TaskRunStatus.COMPLETED ||
      run.status === TaskRunStatus.FAILED ||
      run.status === TaskRunStatus.CANCELLED
    ) {
      return;
    }

    const now = new Date();
    await this.runRepo.update(runId, {
      status: TaskRunStatus.RUNNING,
      startedAt: run.startedAt ?? now,
      error: null,
    });

    const stepRows = await this.runStepRepo.find({
      where: { runId },
      order: { stepIndex: 'ASC' },
    });

    let previousOutput = '';
    let lastSummary = '';

    for (const stepRow of stepRows) {
      if (stepRow.status === TaskRunStepStatus.COMPLETED) {
        previousOutput = stepRow.output ?? '';
        lastSummary = previousOutput.slice(0, 4000);
        continue;
      }
      if (stepRow.status === TaskRunStepStatus.SKIPPED) {
        continue;
      }
      if (stepRow.status === TaskRunStepStatus.FAILED) {
        await this.markRunFailed(runId, `Step ${stepRow.stepIndex} đã failed trước đó.`);
        return;
      }

      const prompt = interpolate(stepRow.inputSnapshot, previousOutput);
      const stepDef = await this.stepDefRepo.findOne({
        where: { taskId: run.taskId, stepOrder: stepRow.stepIndex },
      });
      const timeoutMs = stepDef?.timeoutMs ?? 120000;
      const onFailure = stepDef?.onFailure ?? StepOnFailure.STOP;

      await this.runStepRepo.update(stepRow.id, {
        status: TaskRunStepStatus.RUNNING,
        startedAt: new Date(),
        error: null,
      });
      await this.runRepo.update(runId, { currentStep: stepRow.stepIndex });

      let output: string | null = null;
      let stepError: string | null = null;

      const maxAttempts = stepRow.maxAttempts ?? 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          if (stepRow.executorType === StepExecutorType.OPENCLAW) {
            output = await this.runOpenclawStep(
              run.userId,
              runId,
              stepRow.oaId!,
              prompt,
            );
          } else {
            output = await this.runInternalStep(
              run.userId,
              run.taskId,
              stepRow.stepIndex,
              prompt,
              stepRow.skillCode,
              timeoutMs,
            );
          }
          stepError = null;
          break;
        } catch (e) {
          stepError = e instanceof Error ? e.message : String(e);
          this.logger.warn(
            `Task run=${runId} step=${stepRow.stepIndex} attempt=${attempt}/${maxAttempts} failed: ${stepError}`,
          );
        }
      }

      if (stepError !== null) {
        await this.runStepRepo.update(stepRow.id, {
          status: TaskRunStepStatus.FAILED,
          error: stepError.slice(0, 8000),
          inputSnapshot: prompt,
          finishedAt: new Date(),
        });

        if (onFailure === StepOnFailure.STOP) {
          await this.markRunFailed(runId, `Step ${stepRow.stepIndex} thất bại: ${stepError}`);
          return;
        }
        if (onFailure === StepOnFailure.SKIP) {
          await this.runStepRepo.update(stepRow.id, {
            status: TaskRunStepStatus.SKIPPED,
          });
          continue;
        }
        // StepOnFailure.CONTINUE — ghi failed nhưng tiếp tục
        continue;
      }

      await this.runStepRepo.update(stepRow.id, {
        status: TaskRunStepStatus.COMPLETED,
        output: output?.slice(0, 50000) ?? '',
        inputSnapshot: prompt,
        finishedAt: new Date(),
      });
      previousOutput = output ?? '';
      lastSummary = previousOutput.slice(0, 4000);
    }

    await this.runRepo.update(runId, {
      status: TaskRunStatus.COMPLETED,
      finishedAt: new Date(),
      error: null,
      summary: lastSummary || null,
    });
  }

  async markRunSystemFailure(runId: string, message: string): Promise<void> {
    const trimmed = message.slice(0, 8000);
    await this.runRepo.update(runId, {
      status: TaskRunStatus.FAILED,
      error: trimmed,
      finishedAt: new Date(),
      summary: trimmed.slice(0, 4000),
    });
  }

  /**
   * Mã skill trong DB/API nên là `browser`, `web_search` (khớp @RegisterSkill).
   * Nếu ai đó lưu nhầm `/browser`, bỏ `/` đầu để getRunner/route tier vẫn khớp.
   */
  private normalizeSkillCodeForPipeline(code: string | null): string | undefined {
    if (code == null) return undefined;
    const t = String(code).trim();
    if (!t) return undefined;
    return t.startsWith('/') ? t.slice(1).trim() || undefined : t;
  }

  /**
   * Giống `GatewayService.buildPipelineUserContent`: gợi ý tool rõ ràng cho LLM
   * (không chỉ dựa vào activeSkills → tier trong RouteStep).
   */
  private buildUserContentWithToolHints(original: string, hints: string[]): string {
    if (!hints.length) return original;
    return (
      `[Hệ thống] Người dùng chỉ định dùng tool: ${hints.join(', ')} — ` +
      `thực hiện yêu cầu bằng các tool này (gọi tool thật), không chỉ mô tả.\n\n` +
      original
    );
  }

  /**
   * Với các step liên quan HTTP/WordPress, luôn chèn policy dùng token DB để
   * hạn chế agent hỏi lại credentials.
   */
  private shouldAppendHttpTokenPolicy(
    normalizedSkill: string | undefined,
    prompt: string,
  ): boolean {
    const s = String(normalizedSkill ?? '').toLowerCase();
    if (s === 'http_request' || s === 'wordpress_content_api') return true;

    const p = String(prompt ?? '').toLowerCase();
    return (
      p.includes('http_request') ||
      p.includes('wordpress_content_api') ||
      p.includes('http_tokens') ||
      p.includes('wp-json')
    );
  }

  private appendExecutionPolicy(prompt: string, policy: string): string {
    if (!prompt) return policy;
    const p = prompt.toLowerCase();
    if (p.includes('http_tokens') && p.includes('không hỏi lại credentials')) {
      return prompt;
    }
    return `${prompt}\n\n[Policy bắt buộc] ${policy}`;
  }

  private async runInternalStep(
    userId: number,
    taskId: number,
    stepIndex: number,
    prompt: string,
    skillCode: string | null,
    timeoutMs: number,
  ): Promise<string> {
    const threadId = `task-run:${taskId}:step:${stepIndex}`;
    const normalizedSkill = this.normalizeSkillCodeForPipeline(skillCode);
    const hints = normalizedSkill ? [normalizedSkill] : [];
    const effectivePrompt = this.shouldAppendHttpTokenPolicy(normalizedSkill, prompt)
      ? this.appendExecutionPolicy(prompt, HTTP_TOKEN_EXECUTION_POLICY)
      : prompt;
    const msg: IInboundMessage = {
      channelId: 'task_runner',
      senderId: String(userId),
      content: this.buildUserContentWithToolHints(effectivePrompt, hints),
      timestamp: new Date(),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const ctx = await this.pipelineService.processMessage(msg, {
        userId,
        threadId,
        skills: normalizedSkill ? [normalizedSkill] : undefined,
      });
      if (ctx.error) throw ctx.error;
      return ctx.agentResponse ?? '';
    } finally {
      clearTimeout(timer);
    }
  }

  private async runOpenclawStep(
    ownerUid: number,
    runId: string,
    oaId: number,
    inputText: string,
  ): Promise<string> {
    const agent = await this.openclawAgents.findAgentForOwner(oaId, ownerUid);
    if (!agent) {
      throw new Error(`OpenClaw agent oa_id=${oaId} không tồn tại hoặc không thuộc user.`);
    }
    const result = await this.openclawChat.invokeRelayForWorkflowRun({
      ownerUid,
      runId,
      oaId,
      inputText,
    });
    if (!result.ok) {
      throw new Error(result.reply || 'OpenClaw step failed');
    }
    return result.reply;
  }

  private async markRunFailed(runId: string, error: string): Promise<void> {
    const trimmed = error.slice(0, 8000);
    await this.runRepo.update(runId, {
      status: TaskRunStatus.FAILED,
      error: trimmed,
      finishedAt: new Date(),
      summary: trimmed.slice(0, 4000),
    });
  }
}
