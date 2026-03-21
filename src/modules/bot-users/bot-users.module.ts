import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotUser } from './entities/bot-user.entity';
import { BotAccessGrant } from './entities/bot-access-grant.entity';
import { BotUsersService } from './bot-users.service';
import { BotAccessService } from './bot-access.service';
import { BotDeliveryService } from './bot-delivery.service';
import { BotBootstrapService } from './bot-bootstrap.service';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [TypeOrmModule.forFeature([BotUser, BotAccessGrant]), UsersModule],
  providers: [
    BotUsersService,
    BotAccessService,
    BotDeliveryService,
    BotBootstrapService,
  ],
  exports: [BotUsersService, BotAccessService, BotDeliveryService],
})
export class BotUsersModule {}
