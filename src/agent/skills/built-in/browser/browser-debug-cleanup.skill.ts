import { Injectable, Logger } from '@nestjs/common';
import { RegisterSkill } from '../../decorators/skill.decorator';
import {
  ISkillDefinition,
  ISkillExecutionContext,
  ISkillResult,
  ISkillRunner,
  SkillCategory,
  SkillType,
} from '../../interfaces/skill-runner.interface';
import { UsersService } from '../../../../modules/users/users.service';
import { UserLevel } from '../../../../modules/users/entities/user.entity';
import { WorkspaceService } from '../../../../gateway/workspace/workspace.service';
import { promises as fs } from 'fs';
import * as path from 'path';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    deleteAll: {
      type: 'boolean',
      description:
        'Nếu true thì xóa toàn bộ thư mục con trong $BRAIN_DIR/<identifier>/browser_debug của user hiện tại',
      default: false,
    },
    groupId: {
      type: 'string',
      description:
        'Artifact groupId của browser_debug (vd: 16 ký tự hex do browser skill sinh ra)',
    },
    identifier: {
      type: 'string',
      description:
        'Tùy chọn: identifier dùng để đối chiếu quyền xóa (nếu metadata có lưu identifier)',
    },
    dryRun: {
      type: 'boolean',
      description: 'Nếu true thì không xóa, chỉ kiểm tra quyền + mô tả file cần xóa',
      default: false,
    },
  },
  required: [],
};

@RegisterSkill({
  code: 'browser_debug_cleanup',
  name: 'Browser Debug Cleanup',
  description:
    'Xóa file nháp / debug của browser (HTML, screenshot, skill_draft) trong $BRAIN_DIR/<identifier>/browser_debug. ' +
    'CHỈ gọi khi user yêu cầu **thực sự xóa / dọn** (vd. "xóa giúp", "dọn hộ", "gọi tool xóa", "xóa hết browser_debug"). ' +
    'KHÔNG gọi khi user chỉ hỏi **lệnh**, **cách**, **hướng dẫn**, **syntax**, "cho anh lệnh xóa…" — khi đó chỉ trả lời bằng chữ (vd. `/tool_browser_debug_cleanup` + JSON, hoặc mô tả `deleteAll` / `groupId`). ' +
    'deleteAll=true: xóa toàn bộ; groupId: xóa một nhóm cụ thể; dryRun=true: chỉ liệt kê.',
  category: SkillCategory.BROWSER,
  parametersSchema: PARAMETERS_SCHEMA,
  ownerOnly: true,
})
@Injectable()
export class BrowserDebugCleanupSkill implements ISkillRunner {
  private readonly logger = new Logger(BrowserDebugCleanupSkill.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly workspaceService: WorkspaceService,
  ) {}

  get definition(): ISkillDefinition {
    return {
      code: 'browser_debug_cleanup',
      name: 'Browser Debug Cleanup',
      description:
        'Xóa file nháp/debug trong $BRAIN_DIR/.../browser_debug. Chỉ khi user muốn **thực thi xóa**; nếu chỉ xin lệnh/cách → không gọi, trả lời hướng dẫn. deleteAll=true xóa hết; dryRun=true chỉ xem.',
      category: SkillCategory.BROWSER,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
      ownerOnly: true,
    };
  }

  private sanitizeGroupId(groupId: string): string | null {
    const id = String(groupId ?? '').trim();
    if (!id) return null;
    // groupId của browser skill hiện tại là sha1 slice 16 hex
    if (!/^[a-f0-9]{16}$/i.test(id)) return null;
    return id.toLowerCase();
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const deleteAll = context.parameters.deleteAll === true;
    const groupIdRaw = context.parameters.groupId as string;
    const groupId = this.sanitizeGroupId(groupIdRaw);
    if (!deleteAll && !groupId) {
      return {
        success: false,
        error: 'Provide `groupId` or set `deleteAll=true`',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const user = await this.usersService.findById(context.userId);
    if (!user) {
      return {
        success: false,
        error: `User not found: ${context.userId}`,
        metadata: { durationMs: Date.now() - start },
      };
    }

    const baseDir = path.join(
      this.workspaceService.getUserDir(user.identifier),
      'browser_debug',
    );
    const resolvedBase = path.resolve(baseDir);
    if (deleteAll) {
      const dryRun = Boolean(context.parameters.dryRun);
      const entries = await fs.readdir(resolvedBase).catch(() => []);
      const dirs: string[] = [];
      for (const entry of entries) {
        const full = path.join(resolvedBase, entry);
        const stat = await fs.stat(full).catch(() => null);
        if (stat?.isDirectory()) dirs.push(full);
      }

      if (dryRun) {
        return {
          success: true,
          data: {
            deleteAll: true,
            wouldDeleteCount: dirs.length,
            wouldDelete: dirs,
          },
          metadata: { durationMs: Date.now() - start },
        };
      }

      for (const dir of dirs) {
        const resolvedDir = path.resolve(dir);
        if (!resolvedDir.startsWith(resolvedBase + path.sep)) continue;
        await fs.rm(resolvedDir, { recursive: true, force: true });
      }

      return {
        success: true,
        data: {
          deleteAll: true,
          deletedCount: dirs.length,
          deletedBaseDir: resolvedBase,
        },
        metadata: { durationMs: Date.now() - start },
      };
    }

    const groupDir = path.join(resolvedBase, groupId as string);
    const resolvedGroupDir = path.resolve(groupDir);

    // Safety: only delete under baseDir
    if (!resolvedGroupDir.startsWith(resolvedBase + path.sep)) {
      return {
        success: false,
        error: 'Refusing to delete outside debug base directory',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const metaPath = path.join(resolvedGroupDir, 'meta.json');
    let meta: any = null;
    try {
      const raw = await fs.readFile(metaPath, 'utf8');
      meta = JSON.parse(raw);
    } catch {
      // Allow deletion even if meta missing, but permission cannot be verified
      meta = null;
    }

    const identifierParam = String(context.parameters.identifier ?? '').trim();
    const userIdentifier = user.identifier;

    const isOwner = user.level === UserLevel.OWNER;
    const isCreator = meta?.createdByUserId === context.userId;
    const isIdentifierMatch = meta?.identifier && meta.identifier === userIdentifier;
    const canDelete = isOwner || isCreator || isIdentifierMatch;

    if (!canDelete) {
      return {
        success: false,
        error:
          'Permission denied: only owner or the creator (or matching identifier) can delete this debug group',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const dryRun = Boolean(context.parameters.dryRun);
    if (dryRun) {
      return {
        success: true,
        data: {
          groupId,
          wouldDelete: resolvedGroupDir,
          meta: meta ?? undefined,
          identifierParam: identifierParam || undefined,
        },
        metadata: { durationMs: Date.now() - start },
      };
    }

    await fs.rm(resolvedGroupDir, { recursive: true, force: true });

    return {
      success: true,
      data: {
        deleted: resolvedGroupDir,
        groupId,
      },
      metadata: { durationMs: Date.now() - start },
    };
  }
}

