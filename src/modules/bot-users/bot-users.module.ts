import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotUser } from './entities/bot-user.entity';
import { BotAccessGrant } from './entities/bot-access-grant.entity';
import { BotUsersService } from './bot-users.service';
import { BotUsersController } from './bot-users.controller';
import { BotAccessService } from './bot-access.service';
import { BotDeliveryService } from './bot-delivery.service';
import { BotBootstrapService } from './bot-bootstrap.service';
import { UsersModule } from '../users/users.module';
import { AuthJwtModule } from '../../common/auth-jwt.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([BotUser, BotAccessGrant]),
    UsersModule,
    AuthJwtModule,
  ],
  controllers: [BotUsersController],
  providers: [
    BotUsersService,
    BotAccessService,
    BotDeliveryService,
    BotBootstrapService,
  ],
  exports: [BotUsersService, BotAccessService, BotDeliveryService],
})
export class BotUsersModule {}
