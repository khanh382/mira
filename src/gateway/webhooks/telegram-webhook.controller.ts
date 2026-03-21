import { Controller, Post, Body, Param, HttpCode } from '@nestjs/common';
import { TelegramUpdateProcessorService } from './telegram-update-processor.service';

@Controller('webhooks/telegram')
export class TelegramWebhookController {
  constructor(private readonly processor: TelegramUpdateProcessorService) {}

  @Post(':botToken')
  @HttpCode(200)
  async handleUpdate(@Param('botToken') botToken: string, @Body() update: any) {
    return this.processor.processUpdate(botToken, update);
  }
}
