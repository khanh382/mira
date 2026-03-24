import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Config } from './entities/config.entity';
import { GlobalConfigService } from './global-config.service';
import { GlobalConfigController } from './global-config.controller';
import { UsersModule } from '../users/users.module';
import { AuthJwtModule } from '../../common/auth-jwt.module';

@Module({
  imports: [TypeOrmModule.forFeature([Config]), UsersModule, AuthJwtModule],
  controllers: [GlobalConfigController],
  providers: [GlobalConfigService],
  exports: [GlobalConfigService],
})
export class GlobalConfigModule {}
