import { Module, OnModuleInit } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { GatewayService } from './gateway.service';
import { GatewayController } from './gateway.controller';
import { WorkspaceService } from './workspace/workspace.service';
import { ThreadResolverService } from './session-resolver/session-resolver.service';

import { TelegramWebhookController } from './webhooks/telegram-webhook.controller';
import { DiscordWebhookController } from './webhooks/discord-webhook.controller';
import { ZaloWebhookController } from './webhooks/zalo-webhook.controller';

import { UsersModule } from '../modules/users/users.module';
import { BotUsersModule } from '../modules/bot-users/bot-users.module';
import { ChatModule } from '../modules/chat/chat.module';
import { AgentModule } from '../agent/agent.module';

import { WebChatGateway } from '../agent/channels/webchat/webchat.gateway';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET', 'default_secret'),
        signOptions: {
          expiresIn: configService.get('JWT_EXPIRES_IN', '24h'),
        },
      }),
      inject: [ConfigService],
    }),
    UsersModule,
    BotUsersModule,
    ChatModule,
    AgentModule,
  ],
  controllers: [
    GatewayController,
    TelegramWebhookController,
    DiscordWebhookController,
    ZaloWebhookController,
  ],
  providers: [
    GatewayService,
    WorkspaceService,
    ThreadResolverService,
  ],
  exports: [GatewayService, WorkspaceService],
})
export class GatewayModule implements OnModuleInit {
  constructor(
    private readonly gatewayService: GatewayService,
    private readonly webChatGateway: WebChatGateway,
  ) {}

  onModuleInit() {
    this.webChatGateway.setGatewayService(this.gatewayService);
  }
}
