import { Injectable, Logger } from '@nestjs/common';
import { RegisterSkill } from '../../decorators/skill.decorator';
import { ChannelsService } from '../../../channels/channels.service';
import {
  ISkillRunner,
  ISkillDefinition,
  ISkillExecutionContext,
  ISkillResult,
  SkillCategory,
  SkillType,
} from '../../interfaces/skill-runner.interface';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    channelId: {
      type: 'string',
      enum: ['telegram', 'discord', 'zalo', 'slack', 'webchat'],
      description: 'Target messaging channel',
    },
    targetId: { type: 'string', description: 'User/group/channel ID on the target platform' },
    text: { type: 'string', description: 'Message text to send' },
    media: {
      type: 'array',
      items: { type: 'string' },
      description: 'Media URLs or paths to attach',
    },
    replyTo: { type: 'string', description: 'Message ID to reply to' },
  },
  required: ['channelId', 'targetId', 'text'],
};

@RegisterSkill({
  code: 'message_send',
  name: 'Send Message',
  description:
    'Send a message to a specific user or group via any configured messaging channel ' +
    '(Telegram, Discord, Zalo, Slack, WebChat). ' +
    'Use when you need to proactively notify a user or send a message to another platform.',
  category: SkillCategory.MESSAGING,
  parametersSchema: PARAMETERS_SCHEMA,
})
@Injectable()
export class MessageSendSkill implements ISkillRunner {
  private readonly logger = new Logger(MessageSendSkill.name);

  constructor(private readonly channelsService: ChannelsService) {}

  get definition(): ISkillDefinition {
    return {
      code: 'message_send',
      name: 'Send Message',
      description: 'Send a message via any configured messaging channel',
      category: SkillCategory.MESSAGING,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const { channelId, targetId, text, media, replyTo } = context.parameters;

    const channel = this.channelsService.getChannel(channelId as string);
    if (!channel) {
      return {
        success: false,
        error: `Channel "${channelId}" not found or not configured`,
        data: { availableChannels: this.channelsService.listConfiguredChannels().map((c) => c.meta.id) },
        metadata: { durationMs: Date.now() - start },
      };
    }

    try {
      await channel.sendMessage({
        channelId: channelId as string,
        targetId: targetId as string,
        content: text as string,
        mediaUrls: media as string[],
        replyToMessageId: replyTo as string,
      });

      return {
        success: true,
        data: { channelId, targetId, sent: true },
        metadata: { durationMs: Date.now() - start },
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        metadata: { durationMs: Date.now() - start },
      };
    }
  }
}
