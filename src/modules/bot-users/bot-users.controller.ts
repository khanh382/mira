import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { BotUsersService } from './bot-users.service';
import { SetBotUserDto } from './dto/bot-user-settings.dto';
import { UsersService } from '../users/users.service';
import { UserLevel } from '../users/entities/user.entity';

@Controller('bot-users')
export class BotUsersController {
  constructor(
    private readonly botUsersService: BotUsersService,
    private readonly usersService: UsersService,
  ) {}

  private async assertOwnerOrColleague(uid: number): Promise<void> {
    const user = await this.usersService.findById(uid);
    if (!user) throw new ForbiddenException('Access denied');
    if (user.level !== UserLevel.OWNER && user.level !== UserLevel.COLLEAGUE) {
      throw new ForbiddenException('Only owner or colleague can access this API');
    }
  }

  @Post('set')
  @UseGuards(JwtAuthGuard)
  async set(@Req() req: any, @Body() body: SetBotUserDto) {
    const userId = req.user.uid;
    await this.assertOwnerOrColleague(userId);
    const patch: Record<string, string> = {};

    const telegram = body.telegram_bot_token?.trim();
    const discord = body.discord_bot_token?.trim();
    const slack = body.slack_bot_token?.trim();
    const zalo = body.zalo_bot_token?.trim();
    const googlePath = body.google_console_cloud_json_path?.trim();

    if (telegram) patch['telegramBotToken'] = telegram;
    if (discord) patch['discordBotToken'] = discord;
    if (slack) patch['slackBotToken'] = slack;
    if (zalo) patch['zaloBotToken'] = zalo;
    if (googlePath) patch['googleConsoleCloudJsonPath'] = googlePath;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('No valid fields to set');
    }

    const row = await this.botUsersService.upsertByUserId(userId, patch);
    return this.botUsersService.toPublicRecord(row);
  }

  @Get('view')
  @UseGuards(JwtAuthGuard)
  async view(@Req() req: any) {
    await this.assertOwnerOrColleague(req.user.uid);
    const row = await this.botUsersService.findByUserId(req.user.uid);
    if (!row) return null;
    return this.botUsersService.toPublicRecord(row);
  }
}
