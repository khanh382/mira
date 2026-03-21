import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RegisterSkill } from '../../decorators/skill.decorator';
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
    text: { type: 'string', description: 'Text to convert to speech' },
    voice: {
      type: 'string',
      description: 'Voice ID or name',
      default: 'alloy',
    },
    model: {
      type: 'string',
      enum: ['tts-1', 'tts-1-hd'],
      default: 'tts-1',
    },
    speed: {
      type: 'number',
      description: 'Speed multiplier (0.25-4.0)',
      default: 1.0,
    },
    format: {
      type: 'string',
      enum: ['mp3', 'opus', 'aac', 'flac', 'wav'],
      default: 'mp3',
    },
  },
  required: ['text'],
};

@RegisterSkill({
  code: 'tts',
  name: 'Text-to-Speech',
  description:
    'Convert text to natural-sounding speech audio. ' +
    'Uses OpenAI TTS API or ElevenLabs. ' +
    'Use when the user wants to hear text spoken aloud or needs audio output.',
  category: SkillCategory.MEDIA,
  parametersSchema: PARAMETERS_SCHEMA,
})
@Injectable()
export class TtsSkill implements ISkillRunner {
  private readonly logger = new Logger(TtsSkill.name);

  constructor(private readonly configService: ConfigService) {}

  get definition(): ISkillDefinition {
    return {
      code: 'tts',
      name: 'Text-to-Speech',
      description: 'Convert text to speech audio',
      category: SkillCategory.MEDIA,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const {
      text,
      voice = 'alloy',
      model = 'tts-1',
      speed = 1.0,
      format = 'mp3',
    } = context.parameters;

    const openaiKey = this.configService.get('OPENAI_API_KEY');
    if (!openaiKey) {
      return {
        success: false,
        error: 'No TTS provider configured. Set OPENAI_API_KEY for OpenAI TTS.',
        metadata: { durationMs: Date.now() - start },
      };
    }

    try {
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: text,
          voice,
          speed,
          response_format: format,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `OpenAI TTS API ${response.status}: ${await response.text()}`,
        );
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());

      return {
        success: true,
        data: {
          audio: audioBuffer.toString('base64'),
          format,
          durationEstimate: `~${Math.ceil((text as string).length / 15)}s`,
        },
        metadata: { durationMs: Date.now() - start, provider: 'openai' },
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
