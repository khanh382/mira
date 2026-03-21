import { Injectable, Logger } from '@nestjs/common';
import { RegisterSkill } from '../../decorators/skill.decorator';
import { UsersService } from '../../../../modules/users/users.service';
import { TaskMemoryService } from '../../../../gateway/workspace/task-memory.service';
import {
  ISkillRunner,
  ISkillDefinition,
  ISkillExecutionContext,
  ISkillResult,
  SkillCategory,
  SkillType,
} from '../../interfaces/skill-runner.interface';
import { ModelTier } from '../../../pipeline/model-router/model-tier.enum';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['read', 'append_note', 'set_status', 'list_tasks'],
      description:
        'read = đọc state một task; append_note = thêm ghi chú; set_status = đóng/mở tác vụ; list_tasks = liệt kê task trong phiên',
    },
    taskId: {
      type: 'string',
      description:
        'Bắt buộc cho read/append_note/set_status (vd. task-001-a1b2c3d4).',
    },
    note: {
      type: 'string',
      description: 'Nội dung ghi chú khi action=append_note',
    },
    status: {
      type: 'string',
      enum: ['open', 'done', 'cancelled'],
      description: 'Khi action=set_status',
    },
  },
  required: ['action'],
};

@RegisterSkill({
  code: 'task_memory',
  name: 'Task Memory',
  description:
    'Bộ nhớ tác vụ phức tạp theo phiên chat: mỗi task có taskId riêng, lưu trong $BRAIN_DIR/.../sessions/<thread>/tasks/. ' +
    'Dùng để ghi chú thêm, đọc trạng thái, đóng tác vụ — tránh trộn với MEMORY.md dài hạn.',
  category: SkillCategory.MEMORY,
  parametersSchema: PARAMETERS_SCHEMA,
  minModelTier: ModelTier.CHEAP,
})
@Injectable()
export class TaskMemorySkill implements ISkillRunner {
  private readonly logger = new Logger(TaskMemorySkill.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly taskMemoryService: TaskMemoryService,
  ) {}

  get definition(): ISkillDefinition {
    return {
      code: 'task_memory',
      name: 'Task Memory',
      description: 'Per-thread task memory under $BRAIN_DIR/sessions/.../tasks/',
      category: SkillCategory.MEMORY,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
      minModelTier: ModelTier.CHEAP,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const params = context.parameters as {
      action: string;
      taskId?: string;
      note?: string;
      status?: 'open' | 'done' | 'cancelled';
    };

    const user = await this.usersService.findById(context.userId);
    if (!user?.identifier) {
      return {
        success: false,
        error: 'User not found',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const threadId = context.threadId;
    const action = String(params.action ?? '').trim();

    try {
      if (action === 'list_tasks') {
        const tasks = await this.taskMemoryService.listTasksFromIndex(
          user.identifier,
          threadId,
        );
        return {
          success: true,
          data: { tasks, threadId },
          metadata: { durationMs: Date.now() - start },
        };
      }

      const taskId = String(params.taskId ?? '').trim();
      if (!taskId) {
        return {
          success: false,
          error: 'taskId is required for this action',
          metadata: { durationMs: Date.now() - start },
        };
      }

      if (action === 'read') {
        const state = await this.taskMemoryService.readStatePublic(
          user.identifier,
          threadId,
          taskId,
        );
        if (!state) {
          return {
            success: false,
            error: `Task "${taskId}" not found`,
            metadata: { durationMs: Date.now() - start },
          };
        }
        return {
          success: true,
          data: state,
          metadata: { durationMs: Date.now() - start },
        };
      }

      if (action === 'append_note') {
        const note = String(params.note ?? '').trim();
        if (!note) {
          return {
            success: false,
            error: 'note is required for append_note',
            metadata: { durationMs: Date.now() - start },
          };
        }
        const state = await this.taskMemoryService.appendNote(
          user.identifier,
          threadId,
          taskId,
          note,
        );
        if (!state) {
          return {
            success: false,
            error: `Task "${taskId}" not found`,
            metadata: { durationMs: Date.now() - start },
          };
        }
        return {
          success: true,
          data: state,
          metadata: { durationMs: Date.now() - start },
        };
      }

      if (action === 'set_status') {
        const status = params.status;
        if (!status) {
          return {
            success: false,
            error: 'status is required for set_status',
            metadata: { durationMs: Date.now() - start },
          };
        }
        const state = await this.taskMemoryService.setStatus(
          user.identifier,
          threadId,
          taskId,
          status,
        );
        if (!state) {
          return {
            success: false,
            error: `Task "${taskId}" not found`,
            metadata: { durationMs: Date.now() - start },
          };
        }
        return {
          success: true,
          data: state,
          metadata: { durationMs: Date.now() - start },
        };
      }

      return {
        success: false,
        error: `Unknown action: ${action}`,
        metadata: { durationMs: Date.now() - start },
      };
    } catch (e: any) {
      this.logger.warn(`task_memory failed: ${e?.message}`);
      return {
        success: false,
        error: e?.message ?? String(e),
        metadata: { durationMs: Date.now() - start },
      };
    }
  }
}
