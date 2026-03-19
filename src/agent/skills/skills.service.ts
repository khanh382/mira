import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DiscoveryService } from '@nestjs/core';
import { Skill } from './entities/skill.entity';
import {
  ISkillRunner,
  ISkillDefinition,
  IToolDefinitionForLLM,
  SkillType,
  SkillCategory,
} from './interfaces/skill-runner.interface';
import { SKILL_METADATA, SkillMetadata } from './decorators/skill.decorator';
import { ClawhubLoaderService } from './clawhub/clawhub-loader.service';

/**
 * SkillsService — unified registry cho cả code-based và prompt-based skills.
 *
 * 3 nguồn skill:
 * 1. Built-in code skills — @RegisterSkill() decorator, auto-discovered
 * 2. Dynamic code skills — từ bảng skills_registry, load từ file_path
 * 3. Prompt skills       — từ ClawhHub/workspace SKILL.md, inject vào prompt
 */
@Injectable()
export class SkillsService implements OnModuleInit {
  private readonly logger = new Logger(SkillsService.name);
  private readonly codeRunners = new Map<string, ISkillRunner>();

  constructor(
    @InjectRepository(Skill)
    private readonly skillRepo: Repository<Skill>,
    private readonly discoveryService: DiscoveryService,
    private readonly clawhubLoader: ClawhubLoaderService,
  ) {}

  async onModuleInit() {
    this.discoverBuiltInSkills();
    await this.loadDynamicSkills();
    this.logger.log(
      `Skills ready: ${this.codeRunners.size} code skills, ` +
      `${this.clawhubLoader.listSkills().length} prompt skills`,
    );
  }

  // ─── Code Skill Registry ───────────────────────────────────────────

  registerRunner(runner: ISkillRunner): void {
    this.codeRunners.set(runner.definition.code, runner);
    this.logger.log(`Code skill registered: ${runner.definition.code}`);
  }

  getRunner(skillCode: string): ISkillRunner | undefined {
    return this.codeRunners.get(skillCode);
  }

  listCodeSkills(): ISkillDefinition[] {
    return Array.from(this.codeRunners.values()).map((r) => r.definition);
  }

  listCodeSkillsByCategory(category: SkillCategory): ISkillDefinition[] {
    return this.listCodeSkills().filter((s) => s.category === category);
  }

  /**
   * Trả về tool definitions cho LLM function calling.
   * Chỉ bao gồm code-based skills (có execute()).
   */
  getToolDefinitionsForLLM(options?: {
    categories?: SkillCategory[];
    excludeOwnerOnly?: boolean;
  }): IToolDefinitionForLLM[] {
    let skills = this.listCodeSkills();

    if (options?.categories?.length) {
      skills = skills.filter((s) => options.categories.includes(s.category));
    }
    if (options?.excludeOwnerOnly) {
      skills = skills.filter((s) => !s.ownerOnly);
    }

    return skills.map((skill) => ({
      name: skill.code,
      description: skill.description,
      parameters: skill.parametersSchema || { type: 'object', properties: {} },
    }));
  }

  /**
   * Trả về prompt block cho ClawhHub/prompt-based skills.
   * Inject vào system prompt để LLM biết có những skill nào available.
   */
  getPromptSkillsBlock(skillNames?: string[]): string {
    return this.clawhubLoader.formatForPrompt(skillNames);
  }

  /**
   * Trả về tổng hợp tất cả skills (cả code và prompt).
   */
  listAllSkills(): Array<ISkillDefinition & { available: boolean }> {
    const codeSkills = this.listCodeSkills().map((s) => ({
      ...s,
      available: true,
    }));

    const promptSkills = this.clawhubLoader.listSkills().map((s) => ({
      code: s.name,
      name: s.name,
      description: s.description,
      category: SkillCategory.CLAWHUB,
      type: SkillType.PROMPT,
      available: true,
    }));

    return [...codeSkills, ...promptSkills];
  }

  // ─── Execute ────────────────────────────────────────────────────────

  async executeSkill(
    skillCode: string,
    context: { userId: number; threadId: string; parameters: Record<string, unknown> },
  ) {
    const runner = this.getRunner(skillCode);
    if (!runner) {
      throw new Error(`Skill "${skillCode}" not found or is a prompt-only skill`);
    }
    return runner.execute(context);
  }

  // ─── ClawhHub Operations ───────────────────────────────────────────

  async installFromClawhub(skillName: string) {
    return this.clawhubLoader.installFromClawhub(skillName);
  }

  async searchClawhub(query: string) {
    return this.clawhubLoader.searchClawhub(query);
  }

  // ─── DB CRUD (dynamic skills) ──────────────────────────────────────

  async findAll(): Promise<Skill[]> {
    return this.skillRepo.find();
  }

  async findActive(): Promise<Skill[]> {
    return this.skillRepo.find({ where: { isActive: true } });
  }

  async findByCode(code: string): Promise<Skill | null> {
    return this.skillRepo.findOne({ where: { code } });
  }

  async create(data: Partial<Skill>): Promise<Skill> {
    const skill = this.skillRepo.create(data);
    return this.skillRepo.save(skill);
  }

  async update(id: number, data: Partial<Skill>): Promise<Skill> {
    await this.skillRepo.update(id, data);
    return this.skillRepo.findOne({ where: { id } });
  }

  // ─── Discovery ─────────────────────────────────────────────────────

  private discoverBuiltInSkills(): void {
    const providers = this.discoveryService.getProviders();

    for (const wrapper of providers) {
      const { instance } = wrapper;
      if (!instance?.constructor) continue;

      const meta: SkillMetadata = Reflect.getMetadata(
        SKILL_METADATA,
        instance.constructor,
      );
      if (!meta) continue;

      const runner = instance as ISkillRunner;
      if (typeof runner.execute !== 'function') {
        this.logger.warn(
          `@RegisterSkill(${meta.code}) on ${instance.constructor.name} missing execute()`,
        );
        continue;
      }

      this.registerRunner(runner);
    }
  }

  private async loadDynamicSkills(): Promise<void> {
    try {
      const skills = await this.findActive();
      this.logger.log(`Found ${skills.length} dynamic skills in DB`);
      // TODO: For each skill with file_path, create DynamicSkillRunner
    } catch (error) {
      this.logger.warn(`Could not load dynamic skills: ${error.message}`);
    }
  }
}
