import { Module } from '@nestjs/common';
import { ProvidersService } from './providers.service';
import { GlobalConfigModule } from '../../modules/global-config/global-config.module';

@Module({
  imports: [GlobalConfigModule],
  providers: [ProvidersService],
  exports: [ProvidersService],
})
export class ProvidersModule {}
