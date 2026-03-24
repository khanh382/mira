import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CronJobsService } from './cron-jobs.service';
import { CreateCronJobDto, UpdateCronJobDto } from './dto/cron-job.dto';

@Controller('cron-jobs')
export class CronJobsController {
  constructor(private readonly service: CronJobsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Req() req: any, @Body() body: CreateCronJobDto) {
    return this.service.create(req.user.uid, body);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  async list(@Req() req: any) {
    return this.service.list(req.user.uid);
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
    @Body() body: UpdateCronJobDto,
  ) {
    return this.service.update(id, req.user.uid, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  async remove(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.service.remove(id, req.user.uid);
  }
}
