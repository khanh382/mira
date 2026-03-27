import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import {
  ScheduledTasksService,
  CreateTaskOptions,
} from './scheduled-tasks.service';
import { ScheduledTargetType, TaskSource } from './entities/scheduled-task.entity';
import { UsersService } from '../../modules/users/users.service';
import { DEFAULT_BRAIN_DIR } from '../../config/brain-dir.config';

/**
 * HeartbeatService — kế thừa concept HEARTBEAT.md từ OpenClaw.
 *
 * Mỗi user có file HEARTBEAT.md trong workspace, định nghĩa các tác vụ định kỳ.
 * Service này đọc file, parse ra tasks, và đăng ký vào ScheduledTasksService.
 *
 * Format HEARTBEAT.md:
 * ```markdown
 * ## Kiểm tra email mới
 * - cron: 0 * / * * *        (mỗi giờ)
 * - n8n: my_workflow_key
 * - payload: {"foo":"bar"}     (optional JSON object)
 * - notify: webchat            (optional: webchat|telegram|discord|zalo|slack)
 * - notifyTargetId: <id>       (optional; required for non-webchat)
 *
 * ## Báo cáo hàng ngày
 * - cron: 0 7 * * *           (7h sáng mỗi ngày)
 * - n8n: daily_report
 * ```
 *
 * Hệ thống sẽ tự tạo/cập nhật scheduled_tasks từ file này.
 * Nếu file trống hoặc chỉ có comments → không tạo heartbeat nào.
 */
@Injectable()
export class HeartbeatService implements OnModuleInit {
  private readonly logger = new Logger(HeartbeatService.name);
  private readonly brainDir: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly scheduledTasksService: ScheduledTasksService,
    private readonly usersService: UsersService,
  ) {
    this.brainDir = this.configService.get('BRAIN_DIR', DEFAULT_BRAIN_DIR);
  }

  async onModuleInit() {
    await this.syncAllHeartbeats();
  }

  /**
   * Mỗi 5 phút, rescan HEARTBEAT.md cho tất cả users.
   * Nhẹ vì chỉ đọc file, không gọi LLM.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'heartbeat_sync' })
  async syncAllHeartbeats(): Promise<void> {
    try {
      const baseDir = path.resolve(this.brainDir);
      if (!fs.existsSync(baseDir)) return;

      const entries = fs.readdirSync(baseDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === '_shared') continue;

        const identifier = entry.name;
        await this.syncUserHeartbeat(identifier);
      }
    } catch (error) {
      this.logger.warn(`Heartbeat sync failed: ${error.message}`);
    }
  }

  private async syncUserHeartbeat(identifier: string): Promise<void> {
    const heartbeatPath = path.join(
      path.resolve(this.brainDir),
      identifier,
      'workspace',
      'HEARTBEAT.md',
    );

    if (!fs.existsSync(heartbeatPath)) return;

    const content = fs.readFileSync(heartbeatPath, 'utf-8');
    const tasks = this.parseHeartbeatMd(content);
    if (tasks.length === 0) return;

    const user = await this.usersService.findByIdentifier(identifier);
    if (!user) {
      this.logger.debug(`Heartbeat: user "${identifier}" not found, skipping`);
      return;
    }

    for (const parsed of tasks) {
      const taskCode = `hb_${user.uid}_${this.slugify(parsed.name)}`;

      const existing = await this.scheduledTasksService.findByCode(taskCode);
      if (existing) {
        if (
          existing.cronExpression !== parsed.cron ||
          existing.targetType !== ScheduledTargetType.N8N_WORKFLOW ||
          existing.n8nWorkflowKey !== parsed.workflowKey ||
          JSON.stringify(existing.n8nPayload ?? {}) !==
            JSON.stringify(parsed.payload ?? {}) ||
          (existing.notifyChannelId ?? null) !== (parsed.notifyChannelId ?? null) ||
          (existing.notifyTargetId ?? null) !== (parsed.notifyTargetId ?? null)
        ) {
          await this.scheduledTasksService.update(existing.id, {
            cronExpression: parsed.cron,
            targetType: ScheduledTargetType.N8N_WORKFLOW,
            agentPrompt: null,
            n8nWorkflowKey: parsed.workflowKey,
            n8nPayload: parsed.payload,
            notifyChannelId: parsed.notifyChannelId,
            notifyTargetId: parsed.notifyTargetId,
            allowedSkills: null,
            maxRetries: parsed.retries,
            maxModelTier: null,
            timeoutMs: parsed.timeout,
          });
          this.logger.log(`Heartbeat updated: ${taskCode}`);
        }
        continue;
      }

      try {
        await this.scheduledTasksService.create({
          userId: user.uid,
          code: taskCode,
          name: parsed.name,
          description: `Heartbeat: ${parsed.name}`,
          cronExpression: parsed.cron,
          targetType: ScheduledTargetType.N8N_WORKFLOW,
          agentPrompt: null,
          n8nWorkflowKey: parsed.workflowKey,
          n8nPayload: parsed.payload,
          notifyChannelId: parsed.notifyChannelId,
          notifyTargetId: parsed.notifyTargetId,
          allowedSkills: null,
          source: TaskSource.HEARTBEAT,
          maxRetries: parsed.retries,
          maxModelTier: null,
          timeoutMs: parsed.timeout,
        });
        this.logger.log(
          `Heartbeat created: ${taskCode} for user ${identifier}`,
        );
      } catch (error) {
        this.logger.warn(
          `Heartbeat create failed for ${taskCode}: ${error.message}`,
        );
      }
    }
  }

  // ─── HEARTBEAT.md Parser ──────────────────────────────────

  private parseHeartbeatMd(content: string): Array<{
    name: string;
    cron: string;
    retries: number;
    timeout: number;
    workflowKey: string;
    payload: Record<string, unknown> | null;
    notifyChannelId: string | null;
    notifyTargetId: string | null;
  }> {
    const tasks: any[] = [];
    const sections = content.split(/^##\s+/m).filter((s) => s.trim());

    for (const section of sections) {
      const lines = section.split('\n');
      const name = lines[0]?.trim();
      if (!name) continue;

      const fields = this.extractFields(lines.slice(1));
      if (!fields.cron || !fields.n8n) continue;

      let payload: Record<string, unknown> | null = null;
      if (fields.payload) {
        try {
          const parsed = JSON.parse(fields.payload);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            payload = parsed as Record<string, unknown>;
          }
        } catch {
          payload = null;
        }
      }

      tasks.push({
        name,
        cron: fields.cron,
        retries: fields.retries ? parseInt(fields.retries, 10) : 3,
        timeout: fields.timeout ? parseInt(fields.timeout, 10) : 120000,
        workflowKey: fields.n8n.trim(),
        payload,
        notifyChannelId: fields.notify ? fields.notify.trim() : null,
        notifyTargetId: fields.notifytargetid ? fields.notifytargetid.trim() : null,
      });
    }

    return tasks;
  }

  private extractFields(lines: string[]): Record<string, string> {
    const fields: Record<string, string> = {};

    for (const line of lines) {
      const match = line.match(/^-\s+([\w]+):\s*(.+)$/);
      if (match) {
        fields[match[1].toLowerCase()] = match[2].trim();
      }
    }

    return fields;
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/(^_|_$)/g, '')
      .slice(0, 50);
  }
}
