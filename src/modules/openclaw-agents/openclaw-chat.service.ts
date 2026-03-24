import { BadRequestException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import {
  ChatThread,
  ChatPlatform,
} from '../chat/entities/chat-thread.entity';
import { ThreadsService } from '../chat/threads.service';
import { User } from '../users/entities/user.entity';
import {
  OpenclawAgent,
  OpenclawAgentStatus,
} from './entities/openclaw-agent.entity';
import { OpenclawThread } from './entities/openclaw-thread.entity';
import {
  OpenclawMessage,
  OpenclawMessageRole,
} from './entities/openclaw-message.entity';
import { OpenclawAgentsService } from './openclaw-agents.service';
import { OpenclawRelayHttpService } from './openclaw-relay-http.service';

export interface OpenclawSlashResult {
  handled: boolean;
  response?: string;
}

@Injectable()
export class OpenclawChatService {
  private readonly logger = new Logger(OpenclawChatService.name);

  constructor(
    private readonly threadsService: ThreadsService,
    private readonly agentsService: OpenclawAgentsService,
    private readonly relay: OpenclawRelayHttpService,
    @InjectRepository(OpenclawThread)
    private readonly octRepo: Repository<OpenclawThread>,
    @InjectRepository(OpenclawMessage)
    private readonly ocmRepo: Repository<OpenclawMessage>,
  ) {}

  /** Chuẩn hóa lệnh bot Telegram (bỏ @BotName). */
  stripBotSuffix(text: string): string {
    return text.trim().replace(/@\S+$/, '').trim();
  }

  isOpenclawSlashCommand(text: string): boolean {
    const t = this.stripBotSuffix(text);
    return /^\/agents$/i.test(t) || /^\/oa\b/i.test(t);
  }

  async tryHandleSlashCommands(params: {
    user: User;
    thread: ChatThread;
    platform: ChatPlatform;
    text: string;
    telegramUserId?: string;
    zaloUserId?: string;
    discordUserId?: string;
  }): Promise<OpenclawSlashResult> {
    const raw = this.stripBotSuffix(params.text);
    if (!raw.startsWith('/')) return { handled: false };

    if (/^\/agents$/i.test(raw) || /^\/oa\s+list$/i.test(raw)) {
      const lines = await this.buildAgentsListText(params.user.uid);
      return { handled: true, response: lines };
    }

    const useSystem = /^\/oa\s+use\s+system$/i.test(raw);
    if (useSystem) {
      await this.threadsService.setActiveOpenclawAgent(params.thread.id, null);
      return {
        handled: true,
        response:
          '✅ Đã chuyển về **agent hệ thống** (system). Các tin nhắn tiếp theo dùng pipeline nội bộ.',
      };
    }

    const useMatch = raw.match(/^\/oa\s+use\s+(\d+)$/i);
    if (useMatch) {
      const id = parseInt(useMatch[1]!, 10);
      const agent = await this.agentsService.findAgentForOwner(id, params.user.uid);
      if (!agent) {
        return {
          handled: true,
          response: `⛔ Không có agent OpenClaw oa_id=${id} hoặc agent không thuộc tài khoản của bạn.`,
        };
      }
      if (agent.status === OpenclawAgentStatus.DISABLED) {
        return {
          handled: true,
          response: `⛔ Agent OpenClaw #${id} đang tắt (disabled).`,
        };
      }
      await this.threadsService.setActiveOpenclawAgent(params.thread.id, id);
      return {
        handled: true,
        response:
          `✅ Đã chọn **${agent.name}** (OpenClaw oa_id=${id}). ` +
          `Tin nhắn tiếp theo được lưu ở bảng OpenClaw và gửi qua Gateway đã đăng ký. ` +
          `Phản hồi sẽ có dạng \`${agent.name}: …\`. Gõ \`/oa use system\` để về agent hệ thống.`,
      };
    }

    const newSession = /^\/oa\s+new$/i.test(raw);
    if (newSession) {
      const oaId = params.thread.activeOpenclawAgentId;
      if (!oaId) {
        return {
          handled: true,
          response:
            '⛔ Chưa chọn OpenClaw agent. Dùng `/oa use <oa_id>` trước, hoặc `/agents` để xem danh sách.',
        };
      }
      await this.octRepo.update(
        { chatThreadId: params.thread.id, agentId: oaId },
        { openclawSessionKey: null, updatedAt: new Date() },
      );
      return {
        handled: true,
        response:
          '✅ Đã bắt đầu **phiên OpenClaw mới** (session key đã xóa). Tin nhắn tiếp theo tạo session mới phía relay.',
      };
    }

    if (/^\/oa\b/i.test(raw)) {
      return {
        handled: true,
        response:
          '❌ Lệnh /oa không hợp lệ. Dùng `/oa list`, `/oa use system`, `/oa use <oa_id>`, `/oa new` — xem `/agents`.',
      };
    }

    return { handled: false };
  }

  private async buildAgentsListText(ownerUid: number): Promise<string> {
    const rows = await this.agentsService.listAgentsByOwner(ownerUid);
    const lines: string[] = [
      '**Các Agent có sẵn:**',
      '',
      '- **system** — agent hệ thống',
    ];
    for (const a of rows) {
      const st = a.status === OpenclawAgentStatus.ACTIVE ? 'active' : 'disabled';
      lines.push(
        `- **${a.name}** — \`oa_id=${a.id}\` (${st}) — ${a.domain}:${a.port}`,
      );
    }
    lines.push(
      '',
      '**Lệnh:** `/oa use system` | `/oa use <oa_id>` | `/oa new` (phiên session mới) | `/agents`',
    );
    return lines.join('\n');
  }

  async handleUserTurn(params: {
    user: User;
    thread: ChatThread;
    platform: ChatPlatform;
    effectiveContent: string;
    honorifics: { userTitle: string; botTitle: string };
  }): Promise<{ response: string; runId: string }> {
    const oaId = params.thread.activeOpenclawAgentId;
    if (!oaId) {
      throw new Error('handleUserTurn called without active_openclaw_oa_id');
    }

    const agent = await this.agentsService.getAgentForOwner(oaId, params.user.uid);

    const oct = await this.findOrCreateOpenclawThread({
      chatThreadId: params.thread.id,
      ownerUid: params.user.uid,
      agent,
      platform: params.platform,
      telegramId: params.thread.telegramId ?? undefined,
      zaloId: params.thread.zaloId ?? undefined,
      discordId: params.thread.discordId ?? undefined,
    });

    const userMsg = this.ocmRepo.create({
      id: uuidv4(),
      threadId: oct.id,
      ownerUserId: params.user.uid,
      role: OpenclawMessageRole.USER,
      content: params.effectiveContent,
      agentDisplayName: null,
      extra: null,
    });
    await this.ocmRepo.save(userMsg);

    const wrapped = this.wrapWithHonorifics(
      params.effectiveContent,
      params.honorifics,
    );

    let reply: string;
    let nextSession: string | null = oct.openclawSessionKey;
    let relayOk = false;

    try {
      const out = await this.relay.sendChat({
        agent,
        message: wrapped,
        sessionKey: oct.openclawSessionKey,
      });
      reply = out.reply;
      nextSession = out.sessionKey;
      relayOk = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`OpenClaw relay failed oa_id=${oaId}: ${msg}`);
      reply = `❌ Không gửi được tới OpenClaw: ${msg}`;
    }

    await this.octRepo.update(oct.id, {
      openclawSessionKey: nextSession,
      updatedAt: new Date(),
    });

    const displayLine = `${agent.name}: ${reply}`;

    const asst = this.ocmRepo.create({
      id: uuidv4(),
      threadId: oct.id,
      ownerUserId: params.user.uid,
      role: OpenclawMessageRole.ASSISTANT,
      content: reply,
      agentDisplayName: agent.name,
      extra: null,
    });
    await this.ocmRepo.save(asst);

    if (relayOk) {
      await this.agentsService.markRelaySuccess(agent.id);
    } else {
      await this.agentsService.markRelayFailure(agent.id, reply);
    }

    return {
      response: displayLine,
      runId: `openclaw-${oaId}-${Date.now()}`,
    };
  }

  async handleUserTurnStream(params: {
    user: User;
    thread: ChatThread;
    platform: ChatPlatform;
    effectiveContent: string;
    honorifics: { userTitle: string; botTitle: string };
    onDelta: (delta: string) => void;
  }): Promise<{ response: string; runId: string }> {
    const oaId = params.thread.activeOpenclawAgentId;
    if (!oaId) {
      throw new Error('handleUserTurnStream called without active_openclaw_oa_id');
    }

    const agent = await this.agentsService.getAgentForOwner(oaId, params.user.uid);
    const oct = await this.findOrCreateOpenclawThread({
      chatThreadId: params.thread.id,
      ownerUid: params.user.uid,
      agent,
      platform: params.platform,
      telegramId: params.thread.telegramId ?? undefined,
      zaloId: params.thread.zaloId ?? undefined,
      discordId: params.thread.discordId ?? undefined,
    });

    const userMsg = this.ocmRepo.create({
      id: uuidv4(),
      threadId: oct.id,
      ownerUserId: params.user.uid,
      role: OpenclawMessageRole.USER,
      content: params.effectiveContent,
      agentDisplayName: null,
      extra: null,
    });
    await this.ocmRepo.save(userMsg);

    const wrapped = this.wrapWithHonorifics(
      params.effectiveContent,
      params.honorifics,
    );

    let reply: string;
    let nextSession: string | null = oct.openclawSessionKey;
    let relayOk = false;

    try {
      const out = await this.relay.sendChatStream({
        agent,
        message: wrapped,
        sessionKey: oct.openclawSessionKey,
        onDelta: params.onDelta,
      });
      reply = out.reply;
      nextSession = out.sessionKey;
      relayOk = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`OpenClaw stream failed oa_id=${oaId}: ${msg}`);
      reply = `❌ Không gửi được tới OpenClaw: ${msg}`;
      params.onDelta(reply);
    }

    await this.octRepo.update(oct.id, {
      openclawSessionKey: nextSession,
      updatedAt: new Date(),
    });

    const asst = this.ocmRepo.create({
      id: uuidv4(),
      threadId: oct.id,
      ownerUserId: params.user.uid,
      role: OpenclawMessageRole.ASSISTANT,
      content: reply,
      agentDisplayName: agent.name,
      extra: null,
    });
    await this.ocmRepo.save(asst);

    if (relayOk) {
      await this.agentsService.markRelaySuccess(agent.id);
    } else {
      await this.agentsService.markRelayFailure(agent.id, reply);
    }

    return {
      response: `${agent.name}: ${reply}`,
      runId: `openclaw-stream-${oaId}-${Date.now()}`,
    };
  }

  private wrapWithHonorifics(
    text: string,
    h: { userTitle: string; botTitle: string },
  ): string {
    return (
      `[Backend persona / xưng hô: người dùng="${h.userTitle}", trợ lý="${h.botTitle}"]\n\n` +
      text
    );
  }

  private async findOrCreateOpenclawThread(params: {
    chatThreadId: string;
    ownerUid: number;
    agent: OpenclawAgent;
    platform: ChatPlatform;
    telegramId?: string;
    zaloId?: string;
    discordId?: string;
  }): Promise<OpenclawThread> {
    const existing = await this.octRepo.findOne({
      where: {
        chatThreadId: params.chatThreadId,
        agentId: params.agent.id,
      },
    });
    if (existing) return existing;

    const row = this.octRepo.create({
      id: uuidv4(),
      ownerUserId: params.ownerUid,
      agentId: params.agent.id,
      chatThreadId: params.chatThreadId,
      openclawSessionKey: null,
      platform: params.platform,
      telegramId: params.telegramId,
      zaloId: params.zaloId,
      discordId: params.discordId,
      title: null,
    });
    return this.octRepo.save(row);
  }

  /**
   * Gọi OpenClaw cho tiến trình workflow (không qua chat UI).
   * Phiên theo (runId, oa_id) — không throw; lỗi relay trả ok=false.
   */
  async invokeRelayForWorkflowRun(params: {
    ownerUid: number;
    runId: string;
    oaId: number;
    inputText: string;
  }): Promise<{ ok: boolean; reply: string }> {
    const agent = await this.agentsService.findAgentForOwner(
      params.oaId,
      params.ownerUid,
    );
    if (!agent) {
      return {
        ok: false,
        reply: `Không tìm thấy OpenClaw agent oa_id=${params.oaId} hoặc không thuộc tài khoản.`,
      };
    }
    if (agent.status === OpenclawAgentStatus.DISABLED) {
      return {
        ok: false,
        reply: `OpenClaw agent #${params.oaId} đang disabled.`,
      };
    }

    const oct = await this.findOrCreateWorkflowThreadForRun({
      ownerUid: params.ownerUid,
      agent,
      runId: params.runId,
    });

    const userMsg = this.ocmRepo.create({
      id: uuidv4(),
      threadId: oct.id,
      ownerUserId: params.ownerUid,
      role: OpenclawMessageRole.USER,
      content: params.inputText,
      agentDisplayName: null,
      extra: null,
    });
    await this.ocmRepo.save(userMsg);

    let reply: string;
    let nextSession: string | null = oct.openclawSessionKey;
    let relayOk = false;

    try {
      const out = await this.relay.sendChat({
        agent,
        message: params.inputText,
        sessionKey: oct.openclawSessionKey,
      });
      reply = out.reply;
      nextSession = out.sessionKey;
      relayOk = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `OpenClaw relay failed (workflow) oa_id=${params.oaId}: ${msg}`,
      );
      reply = msg;
    }

    await this.octRepo.update(oct.id, {
      openclawSessionKey: nextSession,
      updatedAt: new Date(),
    });

    const asst = this.ocmRepo.create({
      id: uuidv4(),
      threadId: oct.id,
      ownerUserId: params.ownerUid,
      role: OpenclawMessageRole.ASSISTANT,
      content: reply,
      agentDisplayName: agent.name,
      extra: null,
    });
    await this.ocmRepo.save(asst);

    if (relayOk) {
      await this.agentsService.markRelaySuccess(agent.id);
    } else {
      await this.agentsService.markRelayFailure(agent.id, reply);
    }

    return { ok: relayOk, reply };
  }

  async listSessionsForOwner(params: {
    ownerUid: number;
    agentId?: number;
    chatThreadId?: string;
  }): Promise<
    Array<{
      id: string;
      agentId: number;
      chatThreadId: string | null;
      openclawSessionKey: string | null;
      platform: ChatPlatform;
      title: string | null;
      createdAt: Date;
      updatedAt: Date;
      agent: { id: number; name: string };
    }>
  > {
    const where: Record<string, unknown> = { ownerUserId: params.ownerUid };
    if (params.agentId !== undefined) where['agentId'] = params.agentId;
    if (params.chatThreadId !== undefined) where['chatThreadId'] = params.chatThreadId;

    const rows = await this.octRepo.find({
      where: where as any,
      relations: ['agent'],
      order: { updatedAt: 'DESC' },
      take: 200,
    });

    return rows.map((r) => ({
      id: r.id,
      agentId: r.agentId,
      chatThreadId: r.chatThreadId,
      openclawSessionKey: r.openclawSessionKey,
      platform: r.platform,
      title: r.title,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      agent: { id: r.agent.id, name: r.agent.name },
    }));
  }

  async getSessionDetailForOwner(params: {
    ownerUid: number;
    sessionId: string;
    limit?: number;
  }): Promise<{
    session: OpenclawThread;
    messages: OpenclawMessage[];
  }> {
    const session = await this.octRepo.findOne({
      where: { id: params.sessionId, ownerUserId: params.ownerUid },
      relations: ['agent'],
    });
    if (!session) throw new NotFoundException('OpenClaw session not found');

    const lim = Math.max(1, Math.min(params.limit ?? 50, 200));
    const messages = await this.ocmRepo.find({
      where: { threadId: session.id, ownerUserId: params.ownerUid },
      order: { createdAt: 'DESC' },
      take: lim,
    });

    return {
      session,
      messages: messages.reverse(),
    };
  }

  async switchSessionForWebThread(params: {
    ownerUid: number;
    sessionId: string;
    chatThreadId: string;
  }): Promise<{ ok: true; sessionId: string; chatThreadId: string; agentId: number }> {
    const session = await this.octRepo.findOne({
      where: { id: params.sessionId, ownerUserId: params.ownerUid },
      relations: ['agent'],
    });
    if (!session) throw new NotFoundException('OpenClaw session not found');

    const chatThread = await this.threadsService.findById(params.chatThreadId);
    if (!chatThread || chatThread.userId !== params.ownerUid) {
      throw new NotFoundException('Chat thread not found');
    }
    if (chatThread.platform !== ChatPlatform.WEB) {
      throw new BadRequestException('Only WEB chat thread can switch OpenClaw sessions');
    }

    await this.threadsService.setActiveOpenclawAgent(chatThread.id, session.agentId);
    await this.octRepo.update(session.id, {
      chatThreadId: chatThread.id,
      platform: ChatPlatform.WEB,
      updatedAt: new Date(),
    });

    return {
      ok: true,
      sessionId: session.id,
      chatThreadId: chatThread.id,
      agentId: session.agentId,
    };
  }

  async newSessionForWebThread(params: {
    ownerUid: number;
    chatThreadId: string;
    agentId?: number;
  }): Promise<OpenclawThread> {
    const chatThread = await this.threadsService.findById(params.chatThreadId);
    if (!chatThread || chatThread.userId !== params.ownerUid) {
      throw new NotFoundException('Chat thread not found');
    }
    if (chatThread.platform !== ChatPlatform.WEB) {
      throw new BadRequestException('Only WEB chat thread can create OpenClaw session');
    }

    const resolvedAgentId = params.agentId ?? chatThread.activeOpenclawAgentId ?? null;
    if (!resolvedAgentId) {
      throw new BadRequestException(
        'agentId is required when thread has no active OpenClaw agent',
      );
    }

    const agent = await this.agentsService.findAgentForOwner(
      resolvedAgentId,
      params.ownerUid,
    );
    if (!agent) throw new NotFoundException('OpenClaw agent not found');
    if (agent.status === OpenclawAgentStatus.DISABLED) {
      throw new BadRequestException('OpenClaw agent is disabled');
    }

    await this.threadsService.setActiveOpenclawAgent(chatThread.id, agent.id);

    const existing = await this.octRepo.findOne({
      where: {
        ownerUserId: params.ownerUid,
        agentId: agent.id,
        chatThreadId: chatThread.id,
      },
    });
    if (existing) {
      await this.octRepo.update(existing.id, {
        openclawSessionKey: null,
        updatedAt: new Date(),
      });
      return (await this.octRepo.findOne({ where: { id: existing.id } }))!;
    }

    const created = this.octRepo.create({
      id: uuidv4(),
      ownerUserId: params.ownerUid,
      agentId: agent.id,
      chatThreadId: chatThread.id,
      openclawSessionKey: null,
      platform: ChatPlatform.WEB,
      title: null,
    });
    return this.octRepo.save(created);
  }

  private async findOrCreateWorkflowThreadForRun(params: {
    ownerUid: number;
    agent: OpenclawAgent;
    runId: string;
  }): Promise<OpenclawThread> {
    const title = `workflow:${params.runId}:${params.agent.id}`;
    const existing = await this.octRepo.findOne({
      where: {
        ownerUserId: params.ownerUid,
        agentId: params.agent.id,
        chatThreadId: IsNull(),
        title,
      },
    });
    if (existing) return existing;

    const row = this.octRepo.create({
      id: uuidv4(),
      ownerUserId: params.ownerUid,
      agentId: params.agent.id,
      chatThreadId: null,
      openclawSessionKey: null,
      platform: ChatPlatform.WEB,
      title,
    });
    return this.octRepo.save(row);
  }
}
