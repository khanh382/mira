import { Module } from '@nestjs/common';
import { StopAllService } from './stop-all.service';

@Module({
  providers: [StopAllService],
  exports: [StopAllService],
})
export class ControlModule {}
