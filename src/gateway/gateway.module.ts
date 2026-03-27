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
import { Workflow } from '../agent/workflow/entities/workflow.entity';
import { WorkflowNode } from '../agent/workflow/entities/workflow-node.entity';

import { UsersModule } from '../modules/users/users.module';
import { BotUsersModule } from '../modules/bot-users/bot-users.module';
import { ChatModule } from '../modules/chat/chat.module';
import { AgentModule } from '../agent/agent.module';
import { OpenclawAgentsModule } from '../modules/openclaw-agents/openclaw-agents.module';
import { LearningModule } from '../agent/learning/learning.module';
import { N8nModule } from '../integrations/n8n/n8n.module';
import { ChannelsModule } from '../agent/channels/channels.module';
import { AgentFeedbackModule } from '../agent/feedback/agent-feedback.module';
import { ModelPolicyModule } from '../agent/model-policy/model-policy.module';
import { GlobalConfigModule } from '../modules/global-config/global-config.module';
import { GoogleConnectionsModule } from '../modules/google-connections/google-connections.module';

import { WebChatGateway } from '../agent/channels/webchat/webchat.gateway';
import { N8nCallbackController } from './webhooks/n8n-callback.controller';

@Module({
  imports: [
    AuthJwtModule,
    UsersModule,
    BotUsersModule,
    ChatModule,
    AgentModule,
    OpenclawAgentsModule,
    WorkspaceModule,
    LearningModule,
    N8nModule,
    ChannelsModule,
    AgentFeedbackModule,
    ModelPolicyModule,
    GlobalConfigModule,
    GoogleConnectionsModule,
    TypeOrmModule.forFeature([BotUser, Workflow, WorkflowNode]),
  ],
  controllers: [
    GatewayController,
    TelegramWebhookController,
    DiscordWebhookController,
    ZaloWebhookController,
    N8nCallbackController,
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
