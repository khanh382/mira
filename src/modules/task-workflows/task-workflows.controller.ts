import {
  Body,
  Controller,
  Delete,
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
import { TaskWorkflowsService } from './task-workflows.service';
import {
  CreateWorkflowDto,
  UpdateWorkflowDto,
  ReplaceWorkflowTasksDto,
} from './dto/workflow.dto';

@Controller('task-workflows')
export class TaskWorkflowsController {
  constructor(private readonly service: TaskWorkflowsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Req() req: any, @Body() body: CreateWorkflowDto) {
    return this.service.create(req.user.uid, body);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  async list(@Req() req: any) {
    return this.service.list(req.user.uid);
  }

  @Get('runs')
  @UseGuards(JwtAuthGuard)
  async listRuns(@Req() req: any, @Query('workflowId') workflowId?: string) {
    const id =
      workflowId !== undefined && workflowId !== ''
        ? parseInt(workflowId, 10)
        : undefined;
    return this.service.listRuns(req.user.uid, id);
  }

  @Get('runs/:runId')
  @UseGuards(JwtAuthGuard)
  async getRun(@Req() req: any, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.service.getRunForUser(runId, req.user.uid);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async getOne(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.service.findOneForUser(id, req.user.uid);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateWorkflowDto,
  ) {
    return this.service.update(id, req.user.uid, body);
  }

  @Put(':id/tasks')
  @UseGuards(JwtAuthGuard)
  async replaceTasks(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ReplaceWorkflowTasksDto,
  ) {
    return this.service.replaceTasks(id, req.user.uid, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  async remove(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.service.remove(id, req.user.uid);
  }

  @Post(':id/run')
  @HttpCode(202)
  @UseGuards(JwtAuthGuard)
  async enqueueRun(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.service.enqueueRunForUser(id, req.user.uid);
  }
}
