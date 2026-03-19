import { Injectable, Logger } from '@nestjs/common';
import { ThreadResolverService, ResolvedThread } from './session-resolver/session-resolver.service';
import { WorkspaceService } from './workspace/workspace.service';
import { AgentService } from '../agent/agent.service';
import { ChatService } from '../modules/chat/chat.service';
import { SkillsService } from '../agent/skills/skills.service';
import { IInboundMessage } from '../agent/channels/interfaces/channel.interface';
import { MessageRole } from '../modules/chat/entities/chat-message.entity';
import { ChatPlatform } from '../modules/chat/entities/chat-thread.entity';
import { IPipelineContext } from '../agent/pipeline/interfaces/pipeline-context.interface';
import { ConfigService } from '@nestjs/config';

/**
 * GatewayService — trung tâm điều phối giữa entry points và agent pipeline.
 *
 * 1. Nhận request từ REST / WebSocket / Webhook
 * 2. Resolve thread per-user per-platform
 * 3. Load conversation context
 * 4. Đẩy vào pipeline
 * 5. Persist kết quả
 * 6. Trả response
 *
 * Xử lý song song: mỗi user request là 1 async operation độc lập.
 */
@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(
    private readonly threadResolver: ThreadResolverService,
    private readonly workspaceService: WorkspaceService,
    private readonly agentService: AgentService,
    private readonly chatService: ChatService,
    private readonly skillsService: SkillsService,
    private readonly configService: ConfigService,
  ) {}

  async handleMessage(
    userId: number,
    content: string,
    options?: {
      channelId?: string;
      platform?: ChatPlatform;
      model?: string;
      mediaUrl?: string;
      threadId?: string;
    },
  ): Promise<{
    response: string;
    threadId: string;
    tokensUsed: number;
    runId: string;
  }> {
    const platform = options?.platform ?? ChatPlatform.WEB;

    const { user, thread, isNew } = await this.threadResolver.resolve(
      userId,
      platform,
    );

    this.logger.log(
      `[${user.identifier}] Message received (thread: ${thread.id}, new: ${isNew}, platform: ${platform})`,
    );

    await this.chatService.createMessage({
      threadId: thread.id,
      userId: user.uid,
      role: MessageRole.USER,
      content,
    });

    this.workspaceService.appendSessionEntry(
      user.identifier,
      thread.id,
      {
        type: 'message',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content },
      },
    );

    const channelId = options?.channelId || 'webchat';
    const inboundMessage: IInboundMessage = {
      channelId,
      senderId: user.identifier,
      senderName: user.uname,
      content,
      mediaUrl: options?.mediaUrl,
      timestamp: new Date(),
    };

    const model = options?.model
      || this.configService.get('DEFAULT_MODEL', 'openai/gpt-4o');

    const pipelineResult: IPipelineContext = await this.agentService.handleMessage(
      inboundMessage,
      {
        userId: user.uid,
        threadId: thread.id,
        model,
      },
    );

    const responseContent = pipelineResult.agentResponse || '';
    if (responseContent) {
      await this.chatService.createMessage({
        threadId: thread.id,
        userId: user.uid,
        role: MessageRole.ASSISTANT,
        content: responseContent,
        tokensUsed: pipelineResult.tokensUsed || 0,
      });

      this.workspaceService.appendSessionEntry(
        user.identifier,
        thread.id,
        {
          type: 'message',
          timestamp: new Date().toISOString(),
          message: { role: 'assistant', content: responseContent },
          tokensUsed: pipelineResult.tokensUsed || 0,
        },
      );
    }

    return {
      response: responseContent,
      threadId: thread.id,
      tokensUsed: pipelineResult.tokensUsed || 0,
      runId: pipelineResult.runId,
    };
  }

  async resetThread(
    userId: number,
    platform: ChatPlatform = ChatPlatform.WEB,
  ): Promise<{ threadId: string; message: string }> {
    const { user, thread } = await this.threadResolver.reset(userId, platform);
    return {
      threadId: thread.id,
      message: `Thread reset for ${user.identifier}. New thread: ${thread.id}`,
    };
  }

  async getHistory(userId: number, limit = 50, platform?: ChatPlatform) {
    const { thread } = await this.threadResolver.resolve(
      userId,
      platform ?? ChatPlatform.WEB,
    );
    const messages = await this.chatService.findByThreadId(thread.id, limit);
    return {
      threadId: thread.id,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        tokensUsed: m.tokensUsed,
        createdAt: m.createdAt,
      })),
    };
  }

  getSkills() {
    return this.skillsService.listAllSkills();
  }

  getStatus() {
    return this.agentService.getStatus();
  }
}
