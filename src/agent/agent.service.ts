import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { HooksService } from './hooks/hooks.service';
import { InternalHookEvent } from './hooks/enums/hook-events.enum';
import { ChannelsService } from './channels/channels.service';
import { ProvidersService } from './providers/providers.service';
import { SkillsService } from './skills/skills.service';
import { PipelineService } from './pipeline/pipeline.service';
import { IInboundMessage } from './channels/interfaces/channel.interface';
import { IChannelAdapter } from './channels/interfaces/channel.interface';
import { ILlmProvider } from './providers/interfaces/llm-provider.interface';
import { OpenAIProvider } from './providers/openai/openai.provider';
import { AnthropicProvider } from './providers/anthropic/anthropic.provider';
import { GeminiProvider } from './providers/gemini/gemini.provider';
import { DeepSeekProvider } from './providers/deepseek/deepseek.provider';
import { OpenRouterProvider } from './providers/openrouter/openrouter.provider';
import { OllamaProvider } from './providers/local-llm/ollama.provider';
import { LmStudioProvider } from './providers/local-llm/lmstudio.provider';
import { TelegramChannel } from './channels/telegram/telegram.channel';
import { DiscordChannel } from './channels/discord/discord.channel';
import { ZaloChannel } from './channels/zalo/zalo.channel';
import { SlackChannel } from './channels/slack/slack.channel';

@Injectable()
export class AgentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly hooksService: HooksService,
    private readonly channelsService: ChannelsService,
    private readonly providersService: ProvidersService,
    private readonly skillsService: SkillsService,
    private readonly pipelineService: PipelineService,
    // LLM Providers
    @Optional() private readonly openaiProvider: OpenAIProvider,
    @Optional() private readonly anthropicProvider: AnthropicProvider,
    @Optional() private readonly geminiProvider: GeminiProvider,
    @Optional() private readonly deepseekProvider: DeepSeekProvider,
    @Optional() private readonly openrouterProvider: OpenRouterProvider,
    @Optional() private readonly ollamaProvider: OllamaProvider,
    @Optional() private readonly lmStudioProvider: LmStudioProvider,
    // Channel adapters
    @Optional() private readonly telegramChannel: TelegramChannel,
    @Optional() private readonly discordChannel: DiscordChannel,
    @Optional() private readonly zaloChannel: ZaloChannel,
    @Optional() private readonly slackChannel: SlackChannel,
  ) {}

  async onModuleInit() {
    this.logger.log('Agent system bootstrapping...');

    // Register LLM providers
    const providers: (ILlmProvider | undefined)[] = [
      this.openaiProvider,
      this.anthropicProvider,
      this.geminiProvider,
      this.deepseekProvider,
      this.openrouterProvider,
      this.ollamaProvider,
      this.lmStudioProvider,
    ];
    for (const provider of providers) {
      if (provider) this.providersService.registerProvider(provider);
    }

    // Register channel adapters
    const channels: (IChannelAdapter | undefined)[] = [
      this.telegramChannel,
      this.discordChannel,
      this.zaloChannel,
      this.slackChannel,
    ];
    for (const channel of channels) {
      if (channel) this.channelsService.registerChannel(channel);
    }

    await this.hooksService.emitInternal(InternalHookEvent.AGENT_BOOTSTRAP, {
      context: { phase: 'init' },
    });

    await this.channelsService.initializeAll();

    await this.hooksService.emitInternal(InternalHookEvent.GATEWAY_STARTUP, {
      context: {
        channels: this.channelsService
          .listConfiguredChannels()
          .map((c) => c.meta.id),
        providers: this.providersService
          .listConfiguredProviders()
          .map((p) => p.providerId),
        skills: this.skillsService.listAllSkills().map((s) => s.code),
      },
    });

    this.logger.log('Agent system ready');
  }

  async onModuleDestroy() {
    this.logger.log('Agent system shutting down...');
    await this.hooksService.emitInternal(
      InternalHookEvent.GATEWAY_SHUTDOWN,
      {},
    );
    await this.channelsService.shutdownAll();
  }

  async handleMessage(
    message: IInboundMessage,
    options: {
      userId: number;
      threadId: string;
      actorTelegramId?: string;
      model?: string;
      /** Gợi ý tool từ gateway (ví dụ /browser trong câu) → tier routing. */
      skills?: string[];
    },
  ) {
    return this.pipelineService.processMessage(message, options);
  }

  getStatus() {
    return {
      channels: this.channelsService.listChannels().map((c) => ({
        id: c.meta.id,
        name: c.meta.name,
        configured: c.isConfigured(),
      })),
      providers: this.providersService.listProviders().map((p) => ({
        id: p.providerId,
        name: p.displayName,
        configured: p.isConfigured(),
      })),
      skills: this.skillsService.listAllSkills(),
    };
  }
}
