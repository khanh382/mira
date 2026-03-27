import {
  Body,
  Controller,
  Headers,
  Post,
  HttpCode,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PipelineService } from '../../agent/pipeline/pipeline.service';
import { N8nApiKeysService } from './n8n-api-keys.service';
import { UsersService } from '../../modules/users/users.service';
import { IInboundMessage } from '../../agent/channels/interfaces/channel.interface';

@Controller('webhooks/n8n')
export class N8nBrainController {
  constructor(
    private readonly config: ConfigService,
    private readonly apiKeys: N8nApiKeysService,
    private readonly usersService: UsersService,
    private readonly pipeline: PipelineService,
  ) {}

  private resolveHeaderName(): string {
    return (
      String(this.config.get('N8N_BRAIN_API_KEY_HEADER', '') || '').trim() ||
      'x-mira-api-key'
    ).toLowerCase();
  }

  // (Nest doesn't support per-method dynamic header name well; we read all headers and pick.)
  @HttpCode(200)
  @Post('brain')
  async brain(
    @Body()
    body: {
      input: string;
      threadId?: string;
      metadata?: Record<string, unknown>;
      skills?: string[];
    },
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    const headerName = this.resolveHeaderName();
    const raw = headers[headerName];
    const token =
      Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
    const key = await this.apiKeys.verifyTokenOrNull(token);
    if (!key) {
      throw new UnauthorizedException('Invalid API key');
    }

    const user = await this.usersService.findById(key.userId);
    if (!user) {
      throw new UnauthorizedException('User not found for API key');
    }

    const input = String(body?.input ?? '').trim();
    if (!input) {
      return { ok: false, error: 'input is required' };
    }

    const threadId = String(body.threadId ?? '').trim() || `n8n:${user.uid}`;
    const inbound: IInboundMessage = {
      channelId: 'n8n',
      senderId: user.identifier,
      senderName: user.uname,
      content: input,
      timestamp: new Date(),
      raw: body.metadata ? { metadata: body.metadata } : undefined,
    };

    const ctx = await this.pipeline.processMessage(inbound, {
      userId: user.uid,
      threadId,
      skills: Array.isArray(body.skills) ? body.skills : undefined,
    });

    if (ctx.error) {
      return {
        ok: false,
        runId: ctx.runId,
        error: String((ctx.error as any)?.message ?? ctx.error),
      };
    }

    return {
      ok: true,
      runId: ctx.runId,
      threadId,
      response: ctx.agentResponse ?? '',
      tokensUsed: ctx.tokensUsed ?? 0,
    };
  }
}

