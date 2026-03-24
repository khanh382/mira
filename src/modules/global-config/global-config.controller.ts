import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { GlobalConfigService } from './global-config.service';
import { Config } from './entities/config.entity';

@Controller('config')
export class GlobalConfigController {
  constructor(private readonly globalConfigService: GlobalConfigService) {}

  @Get('view')
  @UseGuards(JwtAuthGuard)
  async view(@Req() req: any) {
    await this.globalConfigService.assertOwner(req.user.uid);
    const config = await this.globalConfigService.getConfig();
    return this.globalConfigService.getMaskedConfig(config);
  }

  @Post('set')
  @UseGuards(JwtAuthGuard)
  async set(@Req() req: any, @Body() body: Partial<Config>) {
    await this.globalConfigService.assertOwner(req.user.uid);
    return this.globalConfigService.updateConfig(body);
  }
}
