import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { UsersService } from '../../modules/users/users.service';
import { UserLevel } from '../../modules/users/entities/user.entity';
import { isColleagueSafeTool } from './tool-safety.config';
import type { ISkillResult } from './interfaces/skill-runner.interface';

/**
 * SkillsService — unified registry cho cả code-based và prompt-based skills.
 *
 * 3 nguồn skill:
 * 1. Built-in code skills — @RegisterSkill() decorator, auto-discovered
 * 2. Shared filesystem skills — $BRAIN_DIR/_shared/skills/<skill_code>/skill.json (skills_registry_manage; không còn ghi DB)
 *    (Entity Skill / bảng skills_registry có thể dùng cho migration hoặc công cụ khác)
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
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
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
   * Catalog cho user/API: kết hợp in-memory definition + display_name từ DB.
   * Trả về danh sách thân thiện để dùng khi chọn skill_code cho task_steps.
   */
  async getSkillCatalog(options?: {
    ownerOnly?: boolean;
    /** Mặc định true: chỉ trả skill có is_display=true. Truyền false để lấy toàn bộ (admin). */
    displayOnly?: boolean;
  }): Promise<Array<{
    skillCode: string;
    skillName: string;
    displayName: string | null;
    description: string;
    category: string;
    minModelTier: string;
    ownerOnly: boolean;
    skillType: string;
    isActive: boolean;
    isDisplay: boolean;
  }>> {
    const dbRows = await this.skillRepo.find({ where: { isActive: true } });
    const dbMap = new Map(dbRows.map((r) => [r.code, r]));

    const showDisplayOnly = options?.displayOnly !== false;

    const defs = this.listCodeSkills();
    return defs
      .filter((d) => !options?.ownerOnly || d.ownerOnly)
      .map((d) => {
        const row = dbMap.get(d.code);
        return {
          skillCode: d.code,
          skillName: d.name,
          displayName: row?.displayName ?? null,
          description: d.description,
          category: d.category,
          minModelTier: d.minModelTier ?? 'cheap',
          ownerOnly: d.ownerOnly ?? false,
          skillType: 'built_in',
          isActive: true,
          isDisplay: row?.isDisplay ?? true,
        };
      })
      .filter((s) => !showDisplayOnly || s.isDisplay)
      .sort((a, b) => a.category.localeCompare(b.category) || a.skillCode.localeCompare(b.skillCode));
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
    context: {
      userId: number;
      threadId: string;
      runId?: string;
      actorTelegramId?: string;
      parameters: Record<string, unknown>;
    },
  ) {
    const start = Date.now();
    const user = await this.usersService.findById(context.userId);
    if (user?.level === UserLevel.CLIENT) {
      return {
        success: false,
        error:
          'Tài khoản client chỉ dùng chat; không được gọi tool/skill code. ' +
          'Cần quyền colleague hoặc owner.',
        metadata: { durationMs: Date.now() - start },
      };
    }

    if (
      user?.level === UserLevel.COLLEAGUE &&
      !isColleagueSafeTool(skillCode)
    ) {
      return {
        success: false,
        error:
          'Tool này không dành cho colleague (chỉ các tool đọc an toàn). ' +
          'Owner mới dùng tool ghi/sửa/xóa/đăng. ' +
          'Human-in-the-loop (xác nhận trên UI) sẽ cần khi mở tool rủi ro cho colleague.',
        metadata: { durationMs: Date.now() - start },
      };
    }

    const runner = this.getRunner(skillCode);
    if (!runner) {
      throw new Error(
        `Skill "${skillCode}" not found or is a prompt-only skill`,
      );
    }

    const timeoutMs = Number(
      this.configService.get('SKILL_EXEC_TIMEOUT_MS', 20000),
    );
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000;

    const signal = AbortSignal.timeout(budget);
    let settled = false;

    return new Promise<ISkillResult>((resolve) => {
      const onAbort = () => {
        if (settled) return;
        settled = true;
        resolve({
          success: false,
          error:
            `Tool bị timeout sau ${budget}ms — hãy thử cách khác hoặc báo lại cho user.`,
          metadata: { durationMs: Date.now() - start, timedOut: true },
        });
      };
      signal.addEventListener('abort', onAbort, { once: true });

      runner
        .execute({ ...context, signal })
        .then((result) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        })
        .catch((err: Error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          if (err?.name === 'AbortError' || signal.aborted) {
            resolve({
              success: false,
              error:
                `Tool bị timeout sau ${budget}ms — hãy thử cách khác hoặc báo lại cho user.`,
              metadata: { durationMs: Date.now() - start, timedOut: true },
            });
          } else {
            resolve({
              success: false,
              error: err?.message ?? String(err),
              metadata: { durationMs: Date.now() - start },
            });
          }
        });
    });
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

  private stableStringify(input: unknown): string {
    const seen = new WeakSet<object>();
    const normalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map((v) => normalize(v));
      if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        if (seen.has(obj)) return null;
        seen.add(obj);
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(obj).sort()) out[k] = normalize(obj[k]);
        return out;
      }
      return value;
    };
    return JSON.stringify(normalize(input) ?? null);
  }

  async findDuplicateForCreate(data: Partial<Skill>): Promise<{
    isDuplicate: boolean;
    reason?: 'skill_code' | 'skill_name_parameters_schema';
    existingSkill?: Skill;
  }> {
    const code = String(data.code ?? '').trim();
    const name = String(data.name ?? '').trim();

    if (code) {
      const byCode = await this.findByCode(code);
      if (byCode) {
        return {
          isDuplicate: true,
          reason: 'skill_code',
          existingSkill: byCode,
        };
      }
    }

    if (name && data.parametersSchema != null) {
      const target = this.stableStringify(data.parametersSchema);
      const all = await this.findAll();
      const matched = all.find(
        (s) =>
          String(s.name ?? '').trim().toLowerCase() === name.toLowerCase() &&
          this.stableStringify(s.parametersSchema) === target,
      );
      if (matched) {
        return {
          isDuplicate: true,
          reason: 'skill_name_parameters_schema',
          existingSkill: matched,
        };
      }
    }

    return { isDuplicate: false };
  }

  async create(data: Partial<Skill>): Promise<Skill> {
    const duplicate = await this.findDuplicateForCreate(data);
    if (duplicate.isDuplicate) {
      throw new Error(
        duplicate.reason === 'skill_code'
          ? 'Duplicate skill_code detected'
          : 'Duplicate skill_name + parameters_schema detected',
      );
    }
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
