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
import { TasksService } from './tasks.service';
import {
  CreateTaskDto,
  UpdateTaskDto,
  ReplaceTaskStepsDto,
} from './dto/task.dto';

@Controller('tasks')
export class TasksController {
  constructor(private readonly service: TasksService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Req() req: any, @Body() body: CreateTaskDto) {
    return this.service.create(req.user.uid, body);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  async list(@Req() req: any) {
    return this.service.list(req.user.uid);
  }

  @Get('runs')
  @UseGuards(JwtAuthGuard)
  async listRuns(@Req() req: any, @Query('taskId') taskId?: string) {
    const id =
      taskId !== undefined && taskId !== '' ? parseInt(taskId, 10) : undefined;
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
    @Body() body: UpdateTaskDto,
  ) {
    return this.service.update(id, req.user.uid, body);
  }

  @Put(':id/steps')
  @UseGuards(JwtAuthGuard)
  async replaceSteps(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ReplaceTaskStepsDto,
  ) {
    return this.service.replaceSteps(id, req.user.uid, body);
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
