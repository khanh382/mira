import { Module } from '@nestjs/common';
import { HooksModule } from './hooks/hooks.module';
import { ChannelsModule } from './channels/channels.module';
import { ProvidersModule } from './providers/providers.module';
import { SkillsModule } from './skills/skills.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { LearningModule } from './learning/learning.module';
import { WorkflowModule } from './workflow/workflow.module';
import { GlobalConfigModule } from '../modules/global-config/global-config.module';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';
import { ControlModule } from './control/control.module';

// Channel adapters
import { TelegramChannel } from './channels/telegram/telegram.channel';
import { DiscordChannel } from './channels/discord/discord.channel';
import { ZaloChannel } from './channels/zalo/zalo.channel';
import { SlackChannel } from './channels/slack/slack.channel';
// WebChatGateway is provided by GatewayModule (needs JwtService)

// LLM Providers
import { OpenAIProvider } from './providers/openai/openai.provider';
import { AnthropicProvider } from './providers/anthropic/anthropic.provider';
import { GeminiProvider } from './providers/gemini/gemini.provider';
import { DeepSeekProvider } from './providers/deepseek/deepseek.provider';
import { OpenRouterProvider } from './providers/openrouter/openrouter.provider';
import { OllamaProvider } from './providers/local-llm/ollama.provider';
import { LmStudioProvider } from './providers/local-llm/lmstudio.provider';

@Module({
  imports: [
    HooksModule,
    ChannelsModule,
    ProvidersModule,
    SkillsModule,
    PipelineModule,
    SchedulerModule,
    LearningModule,
    WorkflowModule,
    GlobalConfigModule,
    ControlModule,
  ],
  controllers: [AgentController],
  providers: [
    AgentService,

    // Channels
    TelegramChannel,
    DiscordChannel,
    ZaloChannel,
    SlackChannel,

    // Providers
    OpenAIProvider,
    AnthropicProvider,
    GeminiProvider,
    DeepSeekProvider,
    OpenRouterProvider,
    OllamaProvider,
    LmStudioProvider,
  ],
  exports: [AgentService, SkillsModule, ControlModule],
})
export class AgentModule {}
