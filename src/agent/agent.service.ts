import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { HooksService } from './hooks/hooks.service';
import { InternalHookEvent } from './hooks/enums/hook-events.enum';
import { ChannelsService } from './channels/channels.service';
import { ProvidersService } from './providers/providers.service';
import { SkillsService } from './skills/skills.service';
import { PipelineService } from './pipeline/pipeline.service';
import { IInboundMessage } from './channels/interfaces/channel.interface';

@Injectable()
export class AgentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly hooksService: HooksService,
    private readonly channelsService: ChannelsService,
    private readonly providersService: ProvidersService,
    private readonly skillsService: SkillsService,
    private readonly pipelineService: PipelineService,
  ) {}

  async onModuleInit() {
    this.logger.log('Agent system bootstrapping...');

    await this.hooksService.emitInternal(InternalHookEvent.AGENT_BOOTSTRAP, {
      context: { phase: 'init' },
    });

    await this.channelsService.initializeAll();

    await this.hooksService.emitInternal(InternalHookEvent.GATEWAY_STARTUP, {
      context: {
        channels: this.channelsService.listConfiguredChannels().map((c) => c.meta.id),
        providers: this.providersService.listConfiguredProviders().map((p) => p.providerId),
        skills: this.skillsService.listSkills().map((s) => s.code),
      },
    });

    this.logger.log('Agent system ready');
  }

  async onModuleDestroy() {
    this.logger.log('Agent system shutting down...');
    await this.hooksService.emitInternal(InternalHookEvent.GATEWAY_SHUTDOWN, {});
    await this.channelsService.shutdownAll();
  }

  async handleMessage(
    message: IInboundMessage,
    options: { userId: number; threadId: string; model?: string },
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
      skills: this.skillsService.listSkills(),
    };
  }
}
