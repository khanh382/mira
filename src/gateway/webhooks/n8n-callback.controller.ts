import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { N8nDispatchService } from '../../integrations/n8n/n8n-dispatch.service';
import { verifyMiraSignature } from '../../integrations/n8n/n8n-signature.util';
import { IN8nCallbackBody } from '../../integrations/n8n/n8n-contract';
import { ChatService } from '../../modules/chat/chat.service';
import { MessageRole } from '../../modules/chat/entities/chat-message.entity';
import { WorkspaceService } from '../workspace/workspace.service';
import { UsersService } from '../../modules/users/users.service';
import { sanitizeLlmDisplayLeakage } from '../../modules/bot-users/llm-output-sanitize';
import { WebChatGateway } from '../../agent/channels/webchat/webchat.gateway';
import { ChannelsService } from '../../agent/channels/channels.service';
import { sanitizeAssistantOutboundPlainText } from '../../modules/bot-users/assistant-outbound-plain-text';

class NonceReplayGuard {
  private readonly seen = new Map<string, number>(); // nonce -> tsMs
  private readonly maxSize = 5000;

  isReplay(nonce: string, tsMs: number, ttlMs: number): boolean {
    const now = Date.now();
    // cleanup occasionally
    if (this.seen.size > this.maxSize) {
      const entries = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k, v] of entries.slice(0, 800)) {
        if (now - v > ttlMs) this.seen.delete(k);
      }
      if (this.seen.size > this.maxSize) {
        // still too big: best-effort prune oldest
        for (const [k] of entries.slice(0, 800)) this.seen.delete(k);
      }
    }

    const prev = this.seen.get(nonce);
    if (typeof prev === 'number' && Math.abs(tsMs - prev) <= ttlMs) {
      return true;
    }
    this.seen.set(nonce, tsMs);
    return false;
  }
}

@Controller('webhooks/n8n')
export class N8nCallbackController {
  private readonly replay = new NonceReplayGuard();

  constructor(
    private readonly config: ConfigService,
    private readonly dispatches: N8nDispatchService,
    private readonly users: UsersService,
    private readonly chat: ChatService,
    private readonly workspace: WorkspaceService,
    private readonly webchat: WebChatGateway,
    private readonly channels: ChannelsService,
  ) {}

  private getCallbackSecretOrThrow(): string {
    const s = String(this.config.get('N8N_CALLBACK_SECRET', '') || '').trim();
    if (!s) {
      throw new Error('N8N_CALLBACK_SECRET is not configured');
    }
    return s;
  }

  private getCallbackTtlMs(): number {
    const raw = this.config.get<string>('N8N_CALLBACK_TTL_MS', '300000');
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 10_000) return 300000;
    return Math.min(Math.floor(n), 30 * 60_000);
  }

  private summarizeResult(result: unknown): string {
    if (result === null || result === undefined) return '';
    if (typeof result === 'string') return result.slice(0, 1200);
    try {
      return JSON.stringify(result).slice(0, 1200);
    } catch {
      return String(result).slice(0, 1200);
    }
  }

  private buildUserMessage(body: IN8nCallbackBody): string {
    const key = body.workflowKey ? ` "${body.workflowKey}"` : '';
    if (body.status === 'SUCCEEDED') {
      const preview = this.summarizeResult(body.result);
      return preview
        ? `✅ Đã chạy xong workflow${key}.\n\nKết quả (rút gọn):\n${preview}`
        : `✅ Đã chạy xong workflow${key}.`;
    }
    if (body.status === 'FAILED') {
      const err = String(body.error ?? 'Unknown error').slice(0, 1200);
      return `❌ Workflow${key} thất bại.\n\nLỗi (rút gọn):\n${err}`;
    }
    return `ℹ️ Workflow${key} cập nhật trạng thái: ${body.status}`;
  }

  private async persistAssistantReply(args: {
    userId: number;
    identifier: string;
    threadId: string;
    content: string;
  }): Promise<void> {
    await this.chat.createMessage({
      threadId: args.threadId,
      userId: args.userId,
      role: MessageRole.ASSISTANT,
      content: args.content,
      tokensUsed: 0,
    });
    this.workspace.appendSessionEntry(args.identifier, args.threadId, {
      type: 'message',
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: sanitizeLlmDisplayLeakage(args.content),
      },
      tokensUsed: 0,
    });
  }

  @Post('callback')
  @HttpCode(200)
  async callback(
    @Body() body: IN8nCallbackBody,
    @Headers('x-mira-ts') tsHeader: string,
    @Headers('x-mira-nonce') nonceHeader: string,
    @Headers('x-mira-signature') sigHeader: string,
  ) {
    const secret = this.getCallbackSecretOrThrow();
    const ttlMs = this.getCallbackTtlMs();

    const ts = String(tsHeader ?? '').trim();
    const nonce = String(nonceHeader ?? '').trim();
    const signature = String(sigHeader ?? '').trim();
    const tsMs = Number(ts);

    if (!ts || !nonce || !signature || !Number.isFinite(tsMs)) {
      return { ok: false, error: 'Missing signature headers' };
    }
    if (Math.abs(Date.now() - tsMs) > ttlMs) {
      return { ok: false, error: 'Signature timestamp expired' };
    }
    if (this.replay.isReplay(nonce, tsMs, ttlMs)) {
      return { ok: true, dedup: true };
    }
    if (
      !verifyMiraSignature({
        secret,
        ts,
        nonce,
        signature,
        body,
      })
    ) {
      return { ok: false, error: 'Invalid signature' };
    }

    const dispatchId = String(body?.dispatchId ?? '').trim();
    if (!dispatchId) return { ok: false, error: 'dispatchId is required' };

    const dispatch = await this.dispatches.findById(dispatchId);
    if (!dispatch) {
      return { ok: true, ignored: true };
    }

    const executionId =
      typeof body.executionId === 'string' ? body.executionId : null;
    const resultPreview = this.summarizeResult(body.result);

    if (body.status === 'SUCCEEDED') {
      await this.dispatches.markSucceeded({
        id: dispatch.id,
        executionId,
        resultPreview: resultPreview ? resultPreview.slice(0, 4000) : null,
      });
    } else if (body.status === 'FAILED') {
      await this.dispatches.markFailed({
        id: dispatch.id,
        executionId,
        error: String(body.error ?? 'Unknown error'),
      });
    } else if (body.status === 'RUNNING') {
      await this.dispatches.markRunning({
        id: dispatch.id,
        executionId,
      });
    }

    const user = await this.users.findById(dispatch.userId);
    if (!user) return { ok: true };

    const content = this.buildUserMessage({
      ...body,
      workflowKey: body.workflowKey ?? dispatch.workflowKey,
    });
    if (dispatch.threadId) {
      await this.persistAssistantReply({
        userId: user.uid,
        identifier: user.identifier,
        threadId: dispatch.threadId,
        content,
      });
    }

    // Notify user on the original channel (best-effort).
    const channelId = dispatch.notifyChannelId;
    if (channelId === 'webchat') {
      this.webchat.emitToUser(user.uid, 'message:response', {
        content: sanitizeAssistantOutboundPlainText(content),
        threadId: dispatch.threadId ?? null,
        tokensUsed: 0,
        runId: `n8n-callback-${dispatch.id}`,
      });
      this.webchat.emitToUser(user.uid, 'message:done', {
        threadId: dispatch.threadId ?? null,
        runId: `n8n-callback-${dispatch.id}`,
      });
    } else if (channelId && dispatch.notifyTargetId) {
      const ch = this.channels.getChannel(channelId);
      if (ch) {
        await ch.sendMessage({
          channelId,
          targetId: dispatch.notifyTargetId,
          content,
        });
      }
    }

    return { ok: true };
  }
}

