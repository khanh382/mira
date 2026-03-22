import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthJwtModule } from '../common/auth-jwt.module';

import { GatewayService } from './gateway.service';
import { GatewayController } from './gateway.controller';
import { WorkspaceModule } from './workspace/workspace.module';
import { ThreadResolverService } from './session-resolver/session-resolver.service';

import { TelegramWebhookController } from './webhooks/telegram-webhook.controller';
import { DiscordWebhookController } from './webhooks/discord-webhook.controller';
import { ZaloWebhookController } from './webhooks/zalo-webhook.controller';
import { TelegramUpdateProcessorService } from './webhooks/telegram-update-processor.service';
import { TelegramFallbackPollingService } from './webhooks/telegram-fallback-polling.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotUser } from '../modules/bot-users/entities/bot-user.entity';

import { UsersModule } from '../modules/users/users.module';
import { BotUsersModule } from '../modules/bot-users/bot-users.module';
import { ChatModule } from '../modules/chat/chat.module';
import { AgentModule } from '../agent/agent.module';
import { OpenclawAgentsModule } from '../modules/openclaw-agents/openclaw-agents.module';

import { WebChatGateway } from '../agent/channels/webchat/webchat.gateway';

@Module({
  imports: [
    AuthJwtModule,
    UsersModule,
    BotUsersModule,
    ChatModule,
    AgentModule,
    OpenclawAgentsModule,
    WorkspaceModule,
    TypeOrmModule.forFeature([BotUser]),
  ],
  controllers: [
    GatewayController,
    TelegramWebhookController,
    DiscordWebhookController,
    ZaloWebhookController,
  ],
  providers: [
    GatewayService,
    ThreadResolverService,
    WebChatGateway,
    TelegramUpdateProcessorService,
    TelegramFallbackPollingService,
  ],
  exports: [GatewayService, WorkspaceModule],
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
