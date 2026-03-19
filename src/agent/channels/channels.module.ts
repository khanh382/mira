import { Module } from '@nestjs/common';
import { ChannelsService } from './channels.service';

/**
 * Import module này và inject ChannelsService để đăng ký channel adapters.
 *
 * Mỗi channel (telegram, discord, zalo, slack, webchat...) nên là
 * một sub-module riêng, tự đăng ký adapter qua ChannelsService.
 */
@Module({
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
