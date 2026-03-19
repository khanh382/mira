import { Module } from '@nestjs/common';
import { ModelRouterService } from './model-router.service';
import { GlobalConfigModule } from '../../../modules/global-config/global-config.module';
import { UsersModule } from '../../../modules/users/users.module';

@Module({
  imports: [GlobalConfigModule, UsersModule],
  providers: [ModelRouterService],
  exports: [ModelRouterService],
})
export class ModelRouterModule {}
