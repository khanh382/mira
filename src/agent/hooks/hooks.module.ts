import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DiscoveryModule } from '@nestjs/core';
import { HooksService } from './hooks.service';

@Global()
@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 20,
    }),
    DiscoveryModule,
  ],
  providers: [HooksService],
  exports: [HooksService],
})
export class HooksModule {}
