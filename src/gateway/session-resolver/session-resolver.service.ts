import { Injectable, Logger } from '@nestjs/common';
import { ThreadsService } from '../../modules/chat/threads.service';
import { UsersService } from '../../modules/users/users.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { ChatThread, ChatPlatform } from '../../modules/chat/entities/chat-thread.entity';
import { User } from '../../modules/users/entities/user.entity';

export interface ResolvedThread {
  user: User;
  thread: ChatThread;
  isNew: boolean;
}

/**
 * ThreadResolverService — tìm hoặc tạo chat thread cho user.
 *
 * Mỗi user có thể có nhiều threads (per-platform hoặc tạo mới tùy ý).
 * - Nếu chưa có active thread trên platform → tạo mới + provision workspace
 * - Touch updatedAt mỗi lần dùng
 */
@Injectable()
export class ThreadResolverService {
  private readonly logger = new Logger(ThreadResolverService.name);

  constructor(
    private readonly threadsService: ThreadsService,
    private readonly usersService: UsersService,
    private readonly workspaceService: WorkspaceService,
  ) {}

  async resolve(
    userId: number,
    platform: ChatPlatform = ChatPlatform.WEB,
  ): Promise<ResolvedThread> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    await this.workspaceService.ensureUserWorkspace(user.identifier);

    let thread = await this.threadsService.findActiveByUserAndPlatform(
      userId,
      platform,
    );
    let isNew = false;

    if (thread) {
      await this.threadsService.touch(thread.id);
      return { user, thread, isNew };
    }

    thread = await this.threadsService.create({
      userId: user.uid,
      platform,
    });
    isNew = true;

    this.logger.log(
      `New thread created for user ${user.identifier} on ${platform}: ${thread.id}`,
    );

    return { user, thread, isNew };
  }

  async reset(
    userId: number,
    platform: ChatPlatform = ChatPlatform.WEB,
  ): Promise<ResolvedThread> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const current = await this.threadsService.findActiveByUserAndPlatform(
      userId,
      platform,
    );
    if (current) {
      await this.threadsService.deactivate(current.id);
      this.logger.log(`Thread deactivated: ${current.id}`);
    }

    const thread = await this.threadsService.create({
      userId: user.uid,
      platform,
    });

    this.logger.log(
      `Thread reset for user ${user.identifier} on ${platform}: ${thread.id}`,
    );

    return { user, thread, isNew: true };
  }
}
