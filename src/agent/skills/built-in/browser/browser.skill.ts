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

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'navigate',
        'screenshot',
        'snapshot',
        'click',
        'type',
        'scroll',
        'evaluate',
        'pdf',
        'status',
      ],
      description: 'Browser action to perform',
    },
    url: { type: 'string', description: 'URL to navigate to' },
    selector: { type: 'string', description: 'CSS selector for click/type actions' },
    text: { type: 'string', description: 'Text to type' },
    script: { type: 'string', description: 'JavaScript to evaluate in page' },
    fullPage: { type: 'boolean', description: 'Full page screenshot', default: true },
    waitMs: { type: 'number', description: 'Wait time in ms after action', default: 1000 },
  },
  required: ['action'],
};

@RegisterSkill({
  code: 'browser',
  name: 'Browser Control',
  description:
    'Control a headless browser via Playwright. ' +
    'Can navigate to URLs, take screenshots, click elements, type text, ' +
    'scroll pages, evaluate JavaScript, and generate PDFs. ' +
    'Use for web scraping, testing, form filling, and visual verification.',
  category: SkillCategory.BROWSER,
  parametersSchema: PARAMETERS_SCHEMA,
  ownerOnly: true,
})
@Injectable()
export class BrowserSkill implements ISkillRunner {
  private readonly logger = new Logger(BrowserSkill.name);
  private browser: any = null;
  private page: any = null;

  get definition(): ISkillDefinition {
    return {
      code: 'browser',
      name: 'Browser Control',
      description: 'Control a headless browser via Playwright',
      category: SkillCategory.BROWSER,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
      ownerOnly: true,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const { action, url, selector, text, script, fullPage, waitMs = 1000 } = context.parameters;

    try {
      switch (action) {
        case 'status':
          return {
            success: true,
            data: {
              browserActive: !!this.browser,
              currentUrl: this.page ? await this.page.url() : null,
            },
            metadata: { durationMs: Date.now() - start },
          };

        case 'navigate': {
          await this.ensureBrowser();
          await this.page.goto(url as string, { waitUntil: 'domcontentloaded' });
          if (waitMs) await this.page.waitForTimeout(waitMs as number);
          const title = await this.page.title();
          return {
            success: true,
            data: { url, title, currentUrl: this.page.url() },
            metadata: { durationMs: Date.now() - start },
          };
        }

        case 'screenshot': {
          await this.ensureBrowser();
          const buffer = await this.page.screenshot({ fullPage: fullPage ?? true });
          return {
            success: true,
            data: {
              screenshot: buffer.toString('base64'),
              format: 'png',
              currentUrl: this.page.url(),
            },
            metadata: { durationMs: Date.now() - start },
          };
        }

        case 'snapshot': {
          await this.ensureBrowser();
          const content = await this.page.content();
          const textContent = await this.page.evaluate(() => document.body.innerText);
          return {
            success: true,
            data: {
              text: (textContent as string).slice(0, 30000),
              currentUrl: this.page.url(),
            },
            metadata: { durationMs: Date.now() - start },
          };
        }

        case 'click': {
          await this.ensureBrowser();
          await this.page.click(selector as string);
          if (waitMs) await this.page.waitForTimeout(waitMs as number);
          return {
            success: true,
            data: { action: 'click', selector },
            metadata: { durationMs: Date.now() - start },
          };
        }

        case 'type': {
          await this.ensureBrowser();
          await this.page.fill(selector as string, text as string);
          return {
            success: true,
            data: { action: 'type', selector, text },
            metadata: { durationMs: Date.now() - start },
          };
        }

        case 'evaluate': {
          await this.ensureBrowser();
          const result = await this.page.evaluate(script as string);
          return {
            success: true,
            data: { result },
            metadata: { durationMs: Date.now() - start },
          };
        }

        default:
          return {
            success: false,
            error: `Unknown browser action: ${action}`,
            metadata: { durationMs: Date.now() - start },
          };
      }
    } catch (error) {
      this.logger.error(`Browser action failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        metadata: { durationMs: Date.now() - start },
      };
    }
  }

  private async ensureBrowser(): Promise<void> {
    if (this.browser && this.page) return;

    try {
      const { chromium } = await import('playwright');
      this.browser = await chromium.launch({ headless: true });
      const browserContext = await this.browser.newContext();
      this.page = await browserContext.newPage();
    } catch {
      throw new Error(
        'Playwright not available. Install with: npx playwright install chromium',
      );
    }
  }
}
