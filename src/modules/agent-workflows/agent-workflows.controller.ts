import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AgentWorkflowsService } from './agent-workflows.service';
import {
  CreateAgentWorkflowDto,
  ReplaceAgentWorkflowStepsDto,
  UpdateAgentWorkflowDto,
} from './dto/agent-workflow.dto';

/**
 * API-only: thiết lập và chạy tiến trình OpenClaw nối tiếp — không qua chat/agent.
 */
@Controller('agent-workflows')
export class AgentWorkflowsController {
  constructor(private readonly service: AgentWorkflowsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Req() req: any, @Body() body: CreateAgentWorkflowDto) {
    return this.service.create(req.user.uid, body);
  }

  /** Danh sách workflow — đặt trước `:id` để không nhầm với path tĩnh `runs`. */
  @Get()
  @UseGuards(JwtAuthGuard)
  async list(@Req() req: any) {
    return this.service.list(req.user.uid);
  }

  @Get('runs')
  @UseGuards(JwtAuthGuard)
  async listRuns(
    @Req() req: any,
    @Query('workflowId') workflowId?: string,
  ) {
    const wfId =
      workflowId !== undefined && workflowId !== ''
        ? parseInt(workflowId, 10)
        : undefined;
    if (workflowId !== undefined && workflowId !== '' && Number.isNaN(wfId)) {
      return this.service.listRuns(req.user.uid);
    }
    return this.service.listRuns(req.user.uid, wfId);
  }

  @Get('runs/:runId')
  @UseGuards(JwtAuthGuard)
  async getRun(
    @Req() req: any,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    return this.service.getRunForOwner(runId, req.user.uid);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async getOne(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.findOneForOwner(id, req.user.uid);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateAgentWorkflowDto,
  ) {
    return this.service.update(id, req.user.uid, body);
  }

  @Put(':id/steps')
  @UseGuards(JwtAuthGuard)
  async replaceSteps(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ReplaceAgentWorkflowStepsDto,
  ) {
    return this.service.replaceSteps(id, req.user.uid, body);
  }

  @Post(':id/run')
  @HttpCode(202)
  @UseGuards(JwtAuthGuard)
  async enqueueRun(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.enqueueRunForUser(id, req.user.uid);
  }
}
