import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { UsersService } from '../users/users.service';
import { UserLevel } from '../users/entities/user.entity';
import {
  CreateWorkflowDto,
  UpdateWorkflowDto,
  ReplaceWorkflowTasksDto,
  AddWorkflowTaskDto,
  PatchWorkflowTaskDto,
} from './dto/workflow.dto';

@Controller('task-workflows')
export class TaskWorkflowsController {
  constructor(
    private readonly service: TaskWorkflowsService,
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
  async create(@Req() req: any, @Body() body: CreateWorkflowDto) {
    await this.assertOwnerOrColleague(req.user.uid);
    return this.service.create(req.user.uid, body);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  async list(@Req() req: any) {
    await this.assertOwnerOrColleague(req.user.uid);
    return this.service.list(req.user.uid);
  }

  @Get('runs')
  @UseGuards(JwtAuthGuard)
  async listRuns(@Req() req: any, @Query('workflowId') workflowId?: string) {
    await this.assertOwnerOrColleague(req.user.uid);
    const id =
      workflowId !== undefined && workflowId !== ''
        ? parseInt(workflowId, 10)
        : undefined;
    return this.service.listRuns(req.user.uid, id);
  }

  @Get('runs/:runId')
  @UseGuards(JwtAuthGuard)
  async getRun(@Req() req: any, @Param('runId', ParseUUIDPipe) runId: string) {
    await this.assertOwnerOrColleague(req.user.uid);
    return this.service.getRunForUser(runId, req.user.uid);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async getOne(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.assertOwnerOrColleague(req.user.uid);
    return this.service.findOneForUser(id, req.user.uid);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateWorkflowDto,
  ) {
    await this.assertOwnerOrColleague(req.user.uid);
    return this.service.update(id, req.user.uid, body);
  }

  @Put(':id/tasks')
  @UseGuards(JwtAuthGuard)
  async replaceTasks(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ReplaceWorkflowTasksDto,
  ) {
    await this.assertOwnerOrColleague(req.user.uid);
    return this.service.replaceTasks(id, req.user.uid, body);
  }

  @Post(':id/tasks')
  @UseGuards(JwtAuthGuard)
  async addTask(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AddWorkflowTaskDto,
  ) {
    await this.assertOwnerOrColleague(req.user.uid);
    return this.service.addTask(id, req.user.uid, body);
  }

  @Patch(':id/tasks/:wtId')
  @UseGuards(JwtAuthGuard)
  async patchTask(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('wtId', ParseIntPipe) wtId: number,
    @Body() body: PatchWorkflowTaskDto,
  ) {
    await this.assertOwnerOrColleague(req.user.uid);
    return this.service.patchTask(id, req.user.uid, wtId, body);
  }

  @Delete(':id/tasks/:wtId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async removeTask(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('wtId', ParseIntPipe) wtId: number,
  ) {
    await this.assertOwnerOrColleague(req.user.uid);
    return this.service.removeTask(id, req.user.uid, wtId);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  async remove(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.assertOwnerOrColleague(req.user.uid);
    await this.service.remove(id, req.user.uid);
  }

  @Post(':id/run')
  @HttpCode(202)
  @UseGuards(JwtAuthGuard)
  async enqueueRun(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.assertOwnerOrColleague(req.user.uid);
    return this.service.enqueueRunForUser(id, req.user.uid);
  }
}
