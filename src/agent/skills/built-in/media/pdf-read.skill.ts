import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
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
    pdf: { type: 'string', description: 'Path or URL to a single PDF file' },
    pdfs: {
      type: 'array',
      items: { type: 'string' },
      description: 'Multiple PDF paths or URLs',
    },
    pageRange: {
      type: 'string',
      description: 'Page range to extract (e.g. "1-5", "1,3,5")',
    },
  },
};

@RegisterSkill({
  code: 'pdf_read',
  name: 'PDF Reader',
  description:
    'Extract text content from PDF files. Supports local paths and URLs. ' +
    'Use when the user wants to read, summarize, or analyze a PDF document.',
  category: SkillCategory.MEDIA,
  parametersSchema: PARAMETERS_SCHEMA,
})
@Injectable()
export class PdfReadSkill implements ISkillRunner {
  private readonly logger = new Logger(PdfReadSkill.name);

  get definition(): ISkillDefinition {
    return {
      code: 'pdf_read',
      name: 'PDF Reader',
      description: 'Extract text content from PDF files',
      category: SkillCategory.MEDIA,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const { pdf, pdfs, pageRange } = context.parameters;

    const pdfList: string[] = [];
    if (pdf) pdfList.push(pdf as string);
    if (pdfs) pdfList.push(...(pdfs as string[]));

    if (pdfList.length === 0) {
      return {
        success: false,
        error: 'No PDF provided. Pass "pdf" or "pdfs" parameter.',
        metadata: { durationMs: Date.now() - start },
      };
    }

    try {
      const results = [];
      for (const pdfPath of pdfList) {
        const content = await this.extractText(pdfPath);
        results.push({ path: pdfPath, content });
      }

      return {
        success: true,
        data: { documents: results },
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

  private async extractText(pdfPath: string): Promise<string> {
    // TODO: Integrate pdf-parse or similar library
    // npm install pdf-parse
    if (pdfPath.startsWith('http')) {
      throw new Error('URL-based PDF reading not yet implemented');
    }

    if (!fs.existsSync(pdfPath)) {
      throw new Error(`PDF file not found: ${pdfPath}`);
    }

    throw new Error(
      'PDF text extraction requires pdf-parse. Install with: npm install pdf-parse',
    );
  }
}
