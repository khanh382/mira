import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UsersService } from '../users/users.service';
import { UserLevel } from '../users/entities/user.entity';
import { OpenclawAgentsService } from './openclaw-agents.service';
import { OpenclawRelayHttpService } from './openclaw-relay-http.service';
import {
  CreateOpenclawAgentDto,
  UpdateOpenclawAgentDto,
  ListOpenclawSessionsQuery,
  SwitchOpenclawSessionDto,
  NewOpenclawSessionDto,
} from './dto/openclaw-agent.dto';
import { OpenclawChatService } from './openclaw-chat.service';

@Controller('openclaw-agents')
export class OpenclawAgentsController {
  constructor(
    private readonly agentsService: OpenclawAgentsService,
    private readonly relayService: OpenclawRelayHttpService,
    private readonly openclawChatService: OpenclawChatService,
    private readonly usersService: UsersService,
  ) {}

  private async assertOwnerOrColleague(uid: number): Promise<void> {
    const user = await this.usersService.findById(uid);
    if (!user) throw new ForbiddenException('Access denied');
    if (user.level !== UserLevel.OWNER && user.level !== UserLevel.COLLEAGUE) {
      throw new ForbiddenException('Only owner or colleague can access this API');
    }
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Req() req: any, @Body() body: CreateOpenclawAgentDto) {
    await this.assertOwnerOrColleague(req.user.uid);
    return this.agentsService.create(req.user.uid, body);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  async list(@Req() req: any) {
    await this.assertOwnerOrColleague(req.user.uid);
    const agents = await this.agentsService.listAgentsByOwner(req.user.uid);
    return agents.map((a) => this.agentsService.toPublicAgent(a));
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async getOne(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.assertOwnerOrColleague(req.user.uid);
    const agent = await this.agentsService.getAgentForOwner(id, req.user.uid);
    return this.agentsService.toPublicAgent(agent);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateOpenclawAgentDto,
  ) {
    await this.assertOwnerOrColleague(req.user.uid);
    return this.agentsService.update(id, req.user.uid, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  async remove(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.assertOwnerOrColleague(req.user.uid);
    await this.agentsService.remove(id, req.user.uid);
  }

  /**
   * Thử kết nối tới Gateway, cập nhật lastHealthAt / lastError, và trả kết quả.
   * Không throw lỗi kết nối ra ngoài — luôn trả 200 với ok=true/false.
   */
  @Post(':id/test-connection')
  @UseGuards(JwtAuthGuard)
  async testConnection(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.assertOwnerOrColleague(req.user.uid);
    const agent = await this.agentsService.getAgentForOwner(id, req.user.uid);

    const result = await this.relayService.pingAgent(agent);

    if (result.ok) {
      await this.agentsService.markRelaySuccess(agent.id);
    } else {
      await this.agentsService.markRelayFailure(agent.id, result.error!);
    }

    const updated = await this.agentsService.getAgentForOwner(id, req.user.uid);
    return {
      ok: result.ok,
      latencyMs: result.latencyMs,
      error: result.error,
      agent: this.agentsService.toPublicAgent(updated),
    };
  }

  /** Danh sách session OpenClaw của user (cho frontend chọn phiên). */
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async listSessions(@Req() req: any, @Query() query: ListOpenclawSessionsQuery) {
    await this.assertOwnerOrColleague(req.user.uid);
    const agentId =
      query.agentId !== undefined ? Number(query.agentId) : undefined;
    return this.openclawChatService.listSessionsForOwner({
      ownerUid: req.user.uid,
      agentId: Number.isFinite(agentId as number) ? agentId : undefined,
      chatThreadId: query.chatThreadId,
    });
  }

  /** Chi tiết 1 session OpenClaw + messages gần nhất. */
  @Get('sessions/:sessionId')
  @UseGuards(JwtAuthGuard)
  async getSessionDetail(
    @Req() req: any,
    @Param('sessionId') sessionId: string,
    @Query('limit') limit?: string,
  ) {
    await this.assertOwnerOrColleague(req.user.uid);
    const parsed = limit !== undefined ? Number(limit) : undefined;
    return this.openclawChatService.getSessionDetailForOwner({
      ownerUid: req.user.uid,
      sessionId,
      limit: Number.isFinite(parsed as number) ? parsed : undefined,
    });
  }

  /** Chọn session có sẵn cho 1 thread WEB. */
  @Post('sessions/:sessionId/switch')
  @UseGuards(JwtAuthGuard)
  async switchSession(
    @Req() req: any,
    @Param('sessionId') sessionId: string,
    @Body() body: SwitchOpenclawSessionDto,
  ) {
    await this.assertOwnerOrColleague(req.user.uid);
    return this.openclawChatService.switchSessionForWebThread({
      ownerUid: req.user.uid,
      sessionId,
      chatThreadId: body.chatThreadId,
    });
  }

  /** Tạo phiên OpenClaw mới (reset session key) cho thread WEB. */
  @Post('sessions/new')
  @UseGuards(JwtAuthGuard)
  async newSession(@Req() req: any, @Body() body: NewOpenclawSessionDto) {
    await this.assertOwnerOrColleague(req.user.uid);
    const session = await this.openclawChatService.newSessionForWebThread({
      ownerUid: req.user.uid,
      chatThreadId: body.chatThreadId,
      agentId: body.agentId,
    });
    return {
      id: session.id,
      agentId: session.agentId,
      chatThreadId: session.chatThreadId,
      openclawSessionKey: session.openclawSessionKey,
      platform: session.platform,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }
}
