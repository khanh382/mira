import { Module } from '@nestjs/common';
import { HooksModule } from './hooks/hooks.module';
import { ChannelsModule } from './channels/channels.module';
import { ProvidersModule } from './providers/providers.module';
import { SkillsModule } from './skills/skills.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';

// Channel adapters
import { TelegramChannel } from './channels/telegram/telegram.channel';
import { DiscordChannel } from './channels/discord/discord.channel';
import { ZaloChannel } from './channels/zalo/zalo.channel';
import { SlackChannel } from './channels/slack/slack.channel';
import { WebChatGateway } from './channels/webchat/webchat.gateway';

// LLM Providers
import { OpenAIProvider } from './providers/openai/openai.provider';
import { AnthropicProvider } from './providers/anthropic/anthropic.provider';
import { GeminiProvider } from './providers/gemini/gemini.provider';
import { DeepSeekProvider } from './providers/deepseek/deepseek.provider';
import { OpenRouterProvider } from './providers/openrouter/openrouter.provider';

@Module({
  imports: [
    HooksModule,
    ChannelsModule,
    ProvidersModule,
    SkillsModule,
    PipelineModule,
  ],
  controllers: [AgentController],
  providers: [
    AgentService,

    // Channels
    TelegramChannel,
    DiscordChannel,
    ZaloChannel,
    SlackChannel,
    WebChatGateway,

    // Providers
    OpenAIProvider,
    AnthropicProvider,
    GeminiProvider,
    DeepSeekProvider,
    OpenRouterProvider,
  ],
  exports: [AgentService],
})
export class AgentModule {}
