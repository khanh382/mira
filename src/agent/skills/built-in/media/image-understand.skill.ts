import { Injectable, Logger } from '@nestjs/common';
import { RegisterSkill } from '../../decorators/skill.decorator';
import {
  ISkillRunner,
  ISkillDefinition,
  ISkillExecutionContext,
  ISkillResult,
  SkillCategory,
  SkillType,
} from '../../interfaces/skill-runner.interface';
import { ModelTier } from '../../../pipeline/model-router/model-tier.enum';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    image: {
      type: 'string',
      description: 'Single image path or URL to analyze',
    },
    images: {
      type: 'array',
      items: { type: 'string' },
      description: 'Multiple image paths or URLs to analyze',
    },
    question: {
      type: 'string',
      description: 'Specific question about the image(s)',
      default: 'Describe this image in detail.',
    },
  },
};

@RegisterSkill({
  code: 'image_understand',
  name: 'Image Understanding',
  description:
    'Analyze and describe images using a vision-capable LLM. ' +
    'Can process local file paths or URLs. ' +
    'Use when the user sends an image and wants it described, analyzed, or has questions about it.',
  category: SkillCategory.MEDIA,
  parametersSchema: PARAMETERS_SCHEMA,
  minModelTier: ModelTier.SKILL,
})
@Injectable()
export class ImageUnderstandSkill implements ISkillRunner {
  private readonly logger = new Logger(ImageUnderstandSkill.name);

  get definition(): ISkillDefinition {
    return {
      code: 'image_understand',
      name: 'Image Understanding',
      description: 'Analyze and describe images using vision LLM',
      category: SkillCategory.MEDIA,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
      minModelTier: ModelTier.SKILL,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const { image, images, question = 'Describe this image in detail.' } = context.parameters;

    const imageList: string[] = [];
    if (image) imageList.push(image as string);
    if (images) imageList.push(...(images as string[]));

    if (imageList.length === 0) {
      return {
        success: false,
        error: 'No image provided. Pass "image" or "images" parameter.',
        metadata: { durationMs: Date.now() - start },
      };
    }

    // TODO: Send to vision-capable LLM (GPT-4o, Claude, Gemini) via ProvidersService
    // ModelRouter đã đảm bảo context sẽ dùng model SKILL tier (vision-capable)
    // Khi implement: inject ProvidersService + ModelRouterService,
    // gọi modelRouter.resolveModel(userId, TOOL_CALL) để lấy vision model
    return {
      success: false,
      error: 'Image understanding requires a vision-capable LLM provider to be configured',
      data: { images: imageList, question },
      metadata: { durationMs: Date.now() - start },
    };
  }
}
