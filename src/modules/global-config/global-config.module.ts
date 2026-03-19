import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Config } from './entities/config.entity';
import { GlobalConfigService } from './global-config.service';

@Module({
  imports: [TypeOrmModule.forFeature([Config])],
  providers: [GlobalConfigService],
  exports: [GlobalConfigService],
})
export class GlobalConfigModule {}
