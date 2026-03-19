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
import { SendMessageDto, ResetThreadDto } from './dto/send-message.dto';

@Controller('gateway')
export class GatewayController {
  constructor(private readonly gatewayService: GatewayService) {}

  @Post('message')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async sendMessage(@Req() req: any, @Body() dto: SendMessageDto) {
    const userId = req.user.uid;
    return this.gatewayService.handleMessage(userId, dto.content, {
      channelId: dto.channelId,
      model: dto.model,
      mediaUrl: dto.mediaUrl,
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
  async getHistory(
    @Req() req: any,
    @Query('limit') limit?: string,
  ) {
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

  @Get('status')
  getStatus() {
    return this.gatewayService.getStatus();
  }
}
