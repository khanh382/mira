import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  UseGuards,
  Query,
  HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { GatewayService } from './gateway.service';
import { SkillsService } from '../agent/skills/skills.service';
import { SendMessageDto, ResetThreadDto } from './dto/send-message.dto';

@Controller('gateway')
export class GatewayController {
  constructor(
    private readonly gatewayService: GatewayService,
    private readonly skillsService: SkillsService,
  ) {}

  @Post('message')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async sendMessage(@Req() req: any, @Body() dto: SendMessageDto) {
    const userId = req.user.uid;
    return this.gatewayService.handleMessage(userId, dto.content, {
      channelId: dto.channelId,
      model: dto.model,
      mediaUrl: dto.mediaUrl,
      mediaPath: dto.mediaPath,
      threadId: dto.threadId,
    });
  }

  @Post('reset')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async resetThread(@Req() req: any, @Body() dto: ResetThreadDto) {
    const userId = req.user.uid;
    return this.gatewayService.resetThread(userId);
  }

  @Get('history')
  @UseGuards(JwtAuthGuard)
  async getHistory(@Req() req: any, @Query('limit') limit?: string) {
    const userId = req.user.uid;
    return this.gatewayService.getHistory(
      userId,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Get('skills')
  getSkills() {
    return this.gatewayService.getSkills();
  }

  /**
   * GET /gateway/skill-catalog — danh sách built-in skills với tên hiển thị thân thiện.
   * Dùng để chọn skill_code khi tạo task_steps.
   * Query: ?category=browser|web|google|... để lọc theo nhóm.
   */
  /**
   * GET /gateway/skill-catalog
   * ?category=browser|web|google|...  — lọc theo nhóm
   * ?all=true                          — trả toàn bộ kể cả skill nội bộ (is_display=false)
   */
  @Get('skill-catalog')
  @UseGuards(JwtAuthGuard)
  async getSkillCatalog(
    @Query('category') category?: string,
    @Query('all') all?: string,
  ) {
    const displayOnly = all !== 'true';
    const catalog = await this.skillsService.getSkillCatalog({ displayOnly });
    if (category) {
      return catalog.filter((s) => s.category === category);
    }
    return catalog;
  }

  @Get('status')
  getStatus() {
    return this.gatewayService.getStatus();
  }
}
