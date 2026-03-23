import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
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
import { SkillsService } from '../../skills.service';
import { UsersService } from '../../../../modules/users/users.service';
import { UserLevel } from '../../../../modules/users/entities/user.entity';
import { WorkspaceService } from '../../../../gateway/workspace/workspace.service';
import { BrowserDomPresetLearnService } from '../../../../gateway/workspace/browser-dom-preset-learn.service';
import { SkillDraftEnrichmentService } from '../../../../gateway/workspace/skill-draft-enrichment.service';
import { getMiraBrowserTempBaseDir } from '../../mira-browser-temp-path';

function buildSkillsRegistryParametersSchema(
  ws: WorkspaceService,
): Record<string, unknown> {
  const brain = ws.getBrainDir().replace(/\\/g, '/');
  const sharedSkills = ws.getSharedSkillsDir().replace(/\\/g, '/');
  return {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'suggest',
        'create',
        'bootstrap_skill',
        'list_registry',
        'find_candidates',
        'select_candidate',
        'run_selected',
        'run_skill',
        'delete_skill',
        'update_skill',
      ],
      description:
        'bootstrap_skill: WRITE disk package (skill.json+README+run.example); MUST set confirmCreate=true. ' +
        `delete_skill / update_skill: owner chỉnh/xóa package dưới ${sharedSkills}/ (BRAIN_DIR trong .env; confirmDelete / confirmUpdate). ` +
        'Do NOT claim saved until tool succeeds. suggest→create: two-step. list_registry / run_skill: read & run.',
    },
    task: {
      type: 'string',
      description: 'Natural language task used to find suitable existing skills.',
    },
    topK: {
      type: 'number',
      description: 'Max candidate skills to return (default 5).',
      default: 5,
    },
    selectedSkillCode: {
      type: 'string',
      description: 'Skill code selected from candidate list.',
    },
    runtimeParams: {
      type: 'object',
      description:
        'Runtime parameters for run_selected / run_skill, e.g. {"content":"Xin chào"}. ' +
        'Optional: userRequest (verbatim /browser B1… text for AI labels in skill_draft), aiEnrichOnFailure (default true), persistArtifactsOnFailure — see top-level params.',
    },
    userRequest: {
      type: 'string',
      description:
        'run_skill / bootstrap_skill: optional verbatim user instruction (e.g. /browser B1…Bn). Merged into runtimeParams for run_skill; stored in skill_draft + used by AI enrichment.',
    },
    aiEnrichOnFailure: {
      type: 'boolean',
      description:
        'run_skill: after failure, call LLM to fill userRequestedSteps / stepLabel on skill_draft (default true). Set false to skip.',
      default: true,
    },
    aiEnrichDraft: {
      type: 'boolean',
      description:
        'bootstrap_skill / create with draftGroupId: run LLM on skill_draft before writing package (labels B1…, executionNotes). Default false.',
      default: false,
    },
    aiEnrichDraftForce: {
      type: 'boolean',
      description:
        'With aiEnrichDraft=true: re-run LLM even if draft already has aiEnrichedAt.',
      default: false,
    },
    persistArtifactsOnFailure: {
      type: 'boolean',
      description:
        'action=run_skill only. Default true: on failure, copy browser snapshots/HTML from OS temp into ' +
        `${brain}/<user>/browser_debug/<draftGroupId>/ and write skill_draft.json (steps + logs) so the agent can ` +
        'call bootstrap_skill with draftGroupId to revise the shared skill. Set false to always delete temp. ' +
        `In background (non-blocking), usedSelector/currentUrl from logs may merge into ${brain}/<user>/browser_dom_presets/<domain>.json.`,
    },
    draftGroupId: {
      type: 'string',
      description:
        'Optional browser_debug groupId to analyze and propose a suitable reusable skill.',
    },
    skillCode: {
      type: 'string',
      description:
        'Skill code: snake_case folder name under _shared/skills/<skill_code>/ (e.g. dang_bai_chi_text).',
    },
    skillName: {
      type: 'string',
      description: 'Human-readable skill name.',
    },
    description: {
      type: 'string',
      description: 'Skill description (what/why).',
    },
    parametersSchema: {
      type: 'object',
      description: 'JSON schema for skill parameters.',
    },
    minModelTier: {
      type: 'string',
      enum: ['cheap', 'skill', 'processor', 'expert'],
      description: 'Minimum model tier for this skill.',
      default: 'skill',
    },
    draftSummary: {
      type: 'string',
      description:
        'Natural language summary used to generate suggestion when fields are incomplete.',
    },
    executionNotes: {
      type: 'string',
      description:
        'action=bootstrap_skill (recommended): Full operator instructions & success criteria in natural language (e.g. B1–Bn: login check, which button to avoid, ' +
        '"after Đăng wait until new post appears on Newsfeed before success"). Stored in skill.json + README so future runs/agents do not lose steps. ' +
        'Merged with `executionNotes` / `successCriteria` / `operatorInstructions` from skill_draft.json when draftGroupId is set.',
    },
    confirmCreate: {
      type: 'boolean',
      description:
        'Required true for action=create and action=bootstrap_skill (safety; without it files are NOT written).',
      default: false,
    },
    overwriteExisting: {
      type: 'boolean',
      description:
        'action=bootstrap_skill or action=create: if true and skill_code folder already exists, delete the package on disk then write the new one. ' +
        'Do NOT use when user only asked to run/chạy skill — use action=run_skill instead.',
      default: false,
    },
    suggestionId: {
      type: 'string',
      description:
        'Suggestion token from the most recent suggest action. Required for action=create.',
    },
    confirmDelete: {
      type: 'boolean',
      description:
        `delete_skill: MUST be true to remove ${sharedSkills}/<skill_code>/ (or legacy *.skill.json).`,
      default: false,
    },
    confirmUpdate: {
      type: 'boolean',
      description:
        'update_skill: MUST be true to merge `patch` into skill.json on disk.',
      default: false,
    },
    patch: {
      type: 'object',
      description:
        'update_skill: partial skill.json merged sâu (object lồng nhau); mảng (vd. steps) thay thế toàn bộ nếu có trong patch.',
    },
    regenerateReadme: {
      type: 'boolean',
      description:
        'update_skill: với layout thư mục package, ghi lại README.md từ skill.json sau merge (mặc định true).',
      default: true,
    },
  },
  required: ['action'],
};
}

@RegisterSkill({
  code: 'skills_registry_manage',
  name: 'Skills Registry Manager',
  description:
    'Owner-only: writes/reads shared skill packages under $BRAIN_DIR/_shared/skills/<skill_code>/. ' +
    'delete_skill (confirmDelete=true) removes package; update_skill (confirmUpdate=true) merges patch into skill.json. ' +
    'run_skill / run_selected = EXECUTE existing package only. bootstrap_skill / create = WRITE disk; duplicate folder → use run_skill OR overwriteExisting=true. ' +
    'bootstrap_skill needs confirmCreate=true (+ skillCode, …). Never claim saved without tool success.',
  category: SkillCategory.RUNTIME,
  parametersSchema: {
    type: 'object',
    properties: { action: { type: 'string' } },
    required: ['action'],
  },
  ownerOnly: true,
  minModelTier: ModelTier.SKILL,
})
@Injectable()
export class SkillsRegistryManageSkill implements ISkillRunner {
  constructor(
    private readonly skillsService: SkillsService,
    private readonly usersService: UsersService,
    private readonly workspaceService: WorkspaceService,
    private readonly browserDomPresetLearnService: BrowserDomPresetLearnService,
    private readonly skillDraftEnrichment: SkillDraftEnrichmentService,
  ) {}

  get definition(): ISkillDefinition {
    const shared = this.workspaceService
      .getSharedSkillsDir()
      .replace(/\\/g, '/');
    return {
      code: 'skills_registry_manage',
      name: 'Skills Registry Manager',
      description:
        `Owner: delete_skill / update_skill để xóa hoặc sửa skill trong ${shared}/ (BRAIN_DIR). run_skill = execute package. bootstrap_skill+confirmCreate = write package. See PROCESSES.md.`,
      category: SkillCategory.RUNTIME,
      type: SkillType.CODE,
      parametersSchema: buildSkillsRegistryParametersSchema(
        this.workspaceService,
      ),
      ownerOnly: true,
      minModelTier: ModelTier.SKILL,
    };
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const params = (context.parameters ?? {}) as any;
    const action = String(params.action ?? '').trim().toLowerCase();

    const user = await this.usersService.findById(context.userId);
    if (!user || user.level !== UserLevel.OWNER) {
      return {
        success: false,
        error: 'Only owner can execute this skill',
        metadata: { durationMs: Date.now() - start },
      };
    }

    try {
      if (action === 'list_registry') {
        const all = await this.listSharedSkillsFromDisk();
        return {
          success: true,
          data: {
            count: all.length,
            storage: `${this.workspaceService
              .getSharedSkillsDir()
              .replace(/\\/g, '/')}/<skill_code>/skill.json`,
            skills: all.map((s) => ({
              skillCode: s.code,
              skillName: s.name,
              description: s.description,
              filePath: s.filePath,
              packageDir: s.packageDir,
              legacyFlatFile: s.legacyFlatFile ?? false,
            })),
          },
          metadata: { durationMs: Date.now() - start },
        };
      }

      if (action === 'delete_skill') {
        if (params.confirmDelete !== true) {
          return {
            success: false,
            error:
              'confirmDelete=true is required for action=delete_skill (safety).',
            metadata: { durationMs: Date.now() - start },
          };
        }
        const code = String(params.skillCode ?? '').trim();
        if (!code) {
          return {
            success: false,
            error: 'skillCode is required for action=delete_skill.',
            metadata: { durationMs: Date.now() - start },
          };
        }
        try {
          const removed = await this.deleteSharedSkillFromDisk(code);
          return {
            success: true,
            data: {
              skillCode: code,
              removedPaths: removed,
            },
            metadata: { durationMs: Date.now() - start },
          };
        } catch (e: any) {
          return {
            success: false,
            error: e?.message ?? String(e),
            metadata: { durationMs: Date.now() - start },
          };
        }
      }

      if (action === 'update_skill') {
        if (params.confirmUpdate !== true) {
          return {
            success: false,
            error:
              'confirmUpdate=true is required for action=update_skill (safety).',
            metadata: { durationMs: Date.now() - start },
          };
        }
        const code = String(params.skillCode ?? '').trim();
        if (!code) {
          return {
            success: false,
            error: 'skillCode is required for action=update_skill.',
            metadata: { durationMs: Date.now() - start },
          };
        }
        const patch = params.patch;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          return {
            success: false,
            error: 'patch (object) is required for action=update_skill.',
            metadata: { durationMs: Date.now() - start },
          };
        }
        const regen =
          params.regenerateReadme !== false &&
          params.regenerateReadme !== 'false';
        try {
          const result = await this.applyPatchToSharedSkillJson(
            context,
            code,
            patch as Record<string, unknown>,
            regen,
          );
          return {
            success: true,
            data: result,
            metadata: { durationMs: Date.now() - start },
          };
        } catch (e: any) {
          return {
            success: false,
            error: e?.message ?? String(e),
            metadata: { durationMs: Date.now() - start },
          };
        }
      }

      if (action === 'run_skill') {
        const code = String(params.skillCode ?? '').trim();
        if (!code) {
          return {
            success: false,
            error: 'skillCode is required for action=run_skill.',
            metadata: { durationMs: Date.now() - start },
          };
        }
        const selected = await this.loadSharedSkillDescriptor(code);
        if (!selected) {
          return {
            success: false,
            error: `Skill "${code}" not found under ${this.workspaceService
              .getSharedSkillsDir()
              .replace(/\\/g, '/')}/`,
            metadata: { durationMs: Date.now() - start },
          };
        }
        await this.writePendingSelection(context, selected.code);
        const runtimeParams =
          params.runtimeParams && typeof params.runtimeParams === 'object'
            ? ({
                ...(params.runtimeParams as Record<string, unknown>),
              } as Record<string, unknown>)
            : {};
        const topUserRequest = String(params.userRequest ?? '').trim();
        if (topUserRequest && !String(runtimeParams.userRequest ?? '').trim()) {
          runtimeParams.userRequest = topUserRequest;
        }
        const topAiEnrich = params.aiEnrichOnFailure;
        if (
          topAiEnrich !== undefined &&
          runtimeParams.aiEnrichOnFailure === undefined
        ) {
          runtimeParams.aiEnrichOnFailure = topAiEnrich;
        }
        const rpPersist = runtimeParams.persistArtifactsOnFailure;
        const topPersist = params.persistArtifactsOnFailure;
        const persistArtifactsOnFailure =
          topPersist === false || topPersist === 'false'
            ? false
            : topPersist === true || topPersist === 'true'
              ? true
              : rpPersist === false || rpPersist === 'false'
                ? false
                : true;
        const runResult = await this.executeDbSkillFile(
          context,
          selected,
          { ...runtimeParams, persistArtifactsOnFailure },
        );
        return {
          success: runResult.success,
          data: {
            selectedSkillCode: selected.code,
            selectedSkillName: selected.name,
            run: runResult,
            ...(runResult.skillTune
              ? {
                  skillTune: runResult.skillTune,
                  nextStepOnFailure:
                    'Artifacts preserved. To update skill: bootstrap_skill + confirmCreate=true + draftGroupId from skillTune; ' +
                    'if skillCode folder exists, add overwriteExisting=true. To only execute again: run_skill.',
                }
              : {}),
          },
          error: runResult.success ? undefined : runResult.error,
          metadata: { durationMs: Date.now() - start },
        };
      }

      if (action === 'suggest') {
        const suggestion = await this.buildSuggestion(context, params);
        const duplicate = await this.findDuplicateOnDisk(suggestion);
        const pending = await this.writePendingSuggestion(
          context,
          suggestion,
          params.draftGroupId,
        );
        return {
          success: true,
          data: {
            suggestion,
            duplicate,
            suggestionId: pending.suggestionId,
            nextStep:
              'Review/edit if needed, then call suggest again for a new version. ' +
              'Only when approved, call action=create with confirmCreate=true and suggestionId from the latest suggestion.',
          },
          metadata: { durationMs: Date.now() - start },
        };
      }

      if (action === 'find_candidates') {
        const task = String(params.task ?? '').trim();
        if (!task) {
          return {
            success: false,
            error: 'task is required for action=find_candidates.',
            metadata: { durationMs: Date.now() - start },
          };
        }
        const topK = Math.max(1, Number(params.topK ?? 5));
        const candidates = await this.findCandidates(task, topK);
        return {
          success: true,
          data: {
            task,
            candidates,
            nextStep:
              'Choose one candidate skillCode, then call action=select_candidate.',
          },
          metadata: { durationMs: Date.now() - start },
        };
      }

      if (action === 'select_candidate') {
        const selectedSkillCode = String(params.selectedSkillCode ?? '').trim();
        if (!selectedSkillCode) {
          return {
            success: false,
            error: 'selectedSkillCode is required for action=select_candidate.',
            metadata: { durationMs: Date.now() - start },
          };
        }
        const selected = await this.loadSharedSkillDescriptor(selectedSkillCode);
        if (!selected) {
          return {
            success: false,
            error: `Skill "${selectedSkillCode}" not found under ${this.workspaceService
              .getSharedSkillsDir()
              .replace(/\\/g, '/')}/`,
            metadata: { durationMs: Date.now() - start },
          };
        }
        await this.writePendingSelection(context, selected.code);
        return {
          success: true,
          data: {
            selectedSkillCode: selected.code,
            selectedSkillName: selected.name,
            parametersSchema: selected.parametersSchema ?? null,
            nextStep:
              'Provide any extra runtime conditions/params, then call action=run_selected.',
          },
          metadata: { durationMs: Date.now() - start },
        };
      }

      if (action === 'run_selected') {
        const pendingSelection = await this.readPendingSelection(context);
        const selectedSkillCode = pendingSelection?.selectedSkillCode;
        if (!selectedSkillCode) {
          return {
            success: false,
            error:
              'No selected candidate found. Call action=find_candidates then action=select_candidate first.',
            metadata: { durationMs: Date.now() - start },
          };
        }
        const selected = await this.loadSharedSkillDescriptor(selectedSkillCode);
        if (!selected) {
          return {
            success: false,
            error: `Selected skill "${selectedSkillCode}" no longer exists on disk.`,
            metadata: { durationMs: Date.now() - start },
          };
        }
        const runtimeParams =
          params.runtimeParams && typeof params.runtimeParams === 'object'
            ? (params.runtimeParams as Record<string, unknown>)
            : {};
        const rpPersist = runtimeParams.persistArtifactsOnFailure;
        const topPersist = params.persistArtifactsOnFailure;
        const persistArtifactsOnFailure =
          topPersist === false || topPersist === 'false'
            ? false
            : topPersist === true || topPersist === 'true'
              ? true
              : rpPersist === false || rpPersist === 'false'
                ? false
                : true;
        const runResult = await this.executeDbSkillFile(
          context,
          selected,
          { ...runtimeParams, persistArtifactsOnFailure },
        );
        return {
          success: runResult.success,
          data: {
            selectedSkillCode: selected.code,
            selectedSkillName: selected.name,
            run: runResult,
            ...(runResult.skillTune
              ? {
                  skillTune: runResult.skillTune,
                  nextStepOnFailure:
                    'Artifacts preserved. To update skill: bootstrap_skill + confirmCreate=true + draftGroupId from skillTune; ' +
                    'if skillCode folder exists, add overwriteExisting=true. To only execute again: run_skill.',
                }
              : {}),
          },
          error: runResult.success ? undefined : runResult.error,
          metadata: { durationMs: Date.now() - start },
        };
      }

      if (action === 'bootstrap_skill') {
        const confirmCreate = params.confirmCreate === true;
        if (!confirmCreate) {
          return {
            success: false,
            error:
              'confirmCreate=true is required for action=bootstrap_skill (safety).',
            metadata: { durationMs: Date.now() - start },
          };
        }
        const suggestion = await this.buildSuggestion(context, params);
        let duplicate = await this.findDuplicateOnDisk(suggestion);
        if (
          duplicate.isDuplicate &&
          duplicate.reason === 'skill_code' &&
          params.overwriteExisting === true
        ) {
          const pkgDir = this.workspaceService.getSharedSkillPackageDir(
            suggestion.skillCode,
          );
          await fs.rm(pkgDir, { recursive: true, force: true }).catch(() => {});
          duplicate = await this.findDuplicateOnDisk(suggestion);
        }
        if (duplicate.isDuplicate) {
          return {
            success: false,
            error: this.formatDuplicateSkillError(
              suggestion.skillCode,
              duplicate,
            ),
            data: { duplicate },
            metadata: { durationMs: Date.now() - start },
          };
        }
        const draftGroupId = String(params.draftGroupId ?? '').trim();
        if (draftGroupId) {
          await this.maybeEnrichDraftBeforeBootstrap(context, params, draftGroupId);
        }
        const stepsFromDraft = draftGroupId
          ? await this.extractStepsFromDraft(context, draftGroupId)
          : null;
        const executionNotesMerged = await this.mergeExecutionNotesFromParamsAndDraft(
          context,
          params,
          draftGroupId,
        );
        const substitute =
          params.substituteContentPlaceholder !== false &&
          params.substituteContentPlaceholder !== 'false';
        let finalSteps: any[] | null = stepsFromDraft?.length
          ? [...stepsFromDraft]
          : null;
        if (
          finalSteps?.length &&
          substitute &&
          this.schemaHasContentProperty(suggestion.parametersSchema)
        ) {
          finalSteps = this.normalizeStepsForSharedSkill(finalSteps, true);
        }

        const pkg = await this.writeSkillPackage({
          context,
          suggestion,
          steps: finalSteps,
          executionNotes: executionNotesMerged,
        });
        const fileUrl = `file://${pkg.skillJsonPath}`;
        return {
          success: true,
          data: {
            skill: {
              code: suggestion.skillCode,
              name: suggestion.skillName,
              filePath: fileUrl,
              packageDir: pkg.pkgDir,
            },
            filesWritten: pkg.filesWritten,
            storage: 'filesystem package (no database)',
            nextStep: `run_skill with skillCode="${suggestion.skillCode}" and runtimeParams from parametersSchema`,
          },
          metadata: { durationMs: Date.now() - start },
        };
      }

      if (action === 'create') {
        const confirmCreate = params.confirmCreate === true;
        if (!confirmCreate) {
          return {
            success: false,
            error:
              'confirmCreate=true is required for action=create (safety confirmation).',
            metadata: { durationMs: Date.now() - start },
          };
        }
        const suggestionId = String(params.suggestionId ?? '').trim();
        if (!suggestionId) {
          return {
            success: false,
            error: 'suggestionId is required for action=create.',
            metadata: { durationMs: Date.now() - start },
          };
        }
        const pending = await this.readPendingSuggestion(context);
        if (!pending || pending.suggestionId !== suggestionId) {
          return {
            success: false,
            error:
              'Suggestion not found or outdated. Please call action=suggest first and use the latest suggestionId.',
            metadata: { durationMs: Date.now() - start },
          };
        }

        const suggestion = pending.suggestion;
        let duplicate = await this.findDuplicateOnDisk(suggestion);
        if (
          duplicate.isDuplicate &&
          duplicate.reason === 'skill_code' &&
          params.overwriteExisting === true
        ) {
          const pkgDir = this.workspaceService.getSharedSkillPackageDir(
            suggestion.skillCode,
          );
          await fs.rm(pkgDir, { recursive: true, force: true }).catch(() => {});
          duplicate = await this.findDuplicateOnDisk(suggestion);
        }
        if (duplicate.isDuplicate) {
          return {
            success: false,
            error: this.formatDuplicateSkillError(
              suggestion.skillCode,
              duplicate,
            ),
            data: { duplicate },
            metadata: { durationMs: Date.now() - start },
          };
        }

        const draftGroupId = String(pending.draftGroupId ?? '').trim();
        if (draftGroupId) {
          await this.maybeEnrichDraftBeforeBootstrap(context, params, draftGroupId);
        }
        const stepsFromDraft = draftGroupId
          ? await this.extractStepsFromDraft(context, draftGroupId)
          : null;
        const executionNotesMerged = await this.mergeExecutionNotesFromParamsAndDraft(
          context,
          params,
          draftGroupId,
        );
        const substitute =
          params.substituteContentPlaceholder !== false &&
          params.substituteContentPlaceholder !== 'false';
        let finalSteps: any[] | null = stepsFromDraft?.length
          ? [...stepsFromDraft]
          : null;
        if (
          finalSteps?.length &&
          substitute &&
          this.schemaHasContentProperty(suggestion.parametersSchema)
        ) {
          finalSteps = this.normalizeStepsForSharedSkill(finalSteps, true);
        }

        const pkg = await this.writeSkillPackage({
          context,
          suggestion,
          steps: finalSteps,
          executionNotes: executionNotesMerged,
        });
        const fileUrl = `file://${pkg.skillJsonPath}`;

        return {
          success: true,
          data: {
            skill: {
              code: suggestion.skillCode,
              name: suggestion.skillName,
              filePath: fileUrl,
              packageDir: pkg.pkgDir,
            },
            usedSuggestionId: suggestionId,
            filesWritten: pkg.filesWritten,
            storage: 'filesystem package (no database row)',
          },
          metadata: { durationMs: Date.now() - start },
        };
      }

      return {
        success: false,
        error: `Unknown action: ${action}`,
        metadata: { durationMs: Date.now() - start },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message ?? String(error),
        metadata: { durationMs: Date.now() - start },
      };
    }
  }

  private schemaHasContentProperty(
    parametersSchema: Record<string, unknown> | null | undefined,
  ): boolean {
    const props = parametersSchema?.properties as Record<string, unknown> | undefined;
    if (!props || typeof props !== 'object') return false;
    return Object.prototype.hasOwnProperty.call(props, 'content');
  }

  /** First browser `type` step: sample text from draft → `$content` for reuse. */
  private normalizeStepsForSharedSkill(steps: any[], substitute: boolean): any[] {
    if (!substitute || !Array.isArray(steps)) return steps;
    let replaced = false;
    return steps.map((s) => {
      if (replaced || String(s?.action).toLowerCase() !== 'type') {
        return { ...s };
      }
      const t = s.text;
      if (typeof t === 'string' && t.length > 0 && !String(t).startsWith('$')) {
        replaced = true;
        return { ...s, text: '$content' };
      }
      return { ...s };
    });
  }

  private buildRunExample(suggestion: {
    skillCode: string;
    parametersSchema: Record<string, unknown>;
  }): Record<string, unknown> {
    const schema = suggestion.parametersSchema ?? {};
    const props =
      (schema.properties as Record<string, unknown> | undefined) ?? {};
    const required = Array.isArray(schema.required)
      ? (schema.required as string[])
      : [];
    const runtimeParams: Record<string, string> = {};
    for (const key of Object.keys(props)) {
      const desc =
        props[key] &&
        typeof props[key] === 'object' &&
        (props[key] as any).description
          ? String((props[key] as any).description)
          : key;
      runtimeParams[key] =
        key === 'content'
          ? 'Nội dung thay đổi mỗi lần (user / agent điền)'
          : `<${desc}>`;
    }
    if (required.length === 0 && Object.keys(runtimeParams).length === 0) {
      runtimeParams.note = 'Thêm field theo parametersSchema trong skill.json';
    }
    return {
      tool: 'skills_registry_manage',
      action: 'run_skill',
      skillCode: suggestion.skillCode,
      runtimeParams,
    };
  }

  private renderSkillReadme(
    suggestion: {
      skillCode: string;
      skillName: string;
      description: string;
    },
    executionNotes?: string,
  ): string {
    const dir = `${path
      .join(
        this.workspaceService.getBrainDir(),
        '_shared',
        'skills',
        suggestion.skillCode,
      )
      .replace(/\\/g, '/')}/`;
    const head: string[] = [
      `# ${suggestion.skillName}`,
      '',
      suggestion.description,
      '',
    ];
    if (executionNotes?.trim()) {
      head.push(
        '## Tiêu chí thành công & yêu cầu vận hành',
        '',
        '*(Lưu khi `bootstrap_skill`; đọc trước khi chỉnh skill hoặc báo user “đã thành công”.)*',
        '',
        executionNotes.trim(),
        '',
      );
    }
    return head
      .concat([
        '## Package',
        '',
        `- \`${dir}skill.json\` — định nghĩa skill (bước browser, parametersSchema, optional \`executionNotes\`).`,
        `- \`${dir}README.md\` — file này.`,
        `- \`${dir}run.example.json\` — ví dụ gọi \`run_skill\`.`,
        '',
        '## Chạy lại',
        '',
        'Tool `skills_registry_manage` với `action=run_skill`, `skillCode` như tên thư mục, và `runtimeParams` khớp `parametersSchema` (ví dụ `content` cho nội dung bài đăng).',
        '',
        `Cookie Facebook: mỗi user dùng file \`${path
          .join(
            this.workspaceService.getBrainDir(),
            '<identifier>',
            'cookies',
            'facebook.com.json',
          )
          .replace(/\\/g, '/')}\` (tự gắn theo user chạy; BRAIN_DIR).`,
        '',
        `Generated at ${new Date().toISOString()}.`,
        '',
      ])
      .join('\n');
  }

  private async writeSkillPackage(opts: {
    context: ISkillExecutionContext;
    suggestion: {
      skillCode: string;
      skillName: string;
      description: string;
      parametersSchema: Record<string, unknown>;
      minModelTier: string;
    };
    steps?: any[] | null;
    /** Quy trình / tiêu chí thành công (vd. chờ bài trên Newsfeed) — lưu trong JSON + README. */
    executionNotes?: string;
  }): Promise<{
    pkgDir: string;
    skillJsonPath: string;
    filesWritten: string[];
  }> {
    const { context, suggestion, steps, executionNotes } = opts;
    const pkgDir = this.workspaceService.getSharedSkillPackageDir(
      suggestion.skillCode,
    );
    await fs.mkdir(pkgDir, { recursive: true });
    const defPath = this.workspaceService.getSharedSkillDefinitionPath(
      suggestion.skillCode,
    );

    const filePayload: Record<string, unknown> = {
      code: suggestion.skillCode,
      name: suggestion.skillName,
      description: suggestion.description,
      parametersSchema: suggestion.parametersSchema,
      minModelTier: suggestion.minModelTier,
      createdAt: new Date().toISOString(),
      createdByUserId: context.userId,
      packageLayout: '$BRAIN_DIR/_shared/skills/<skill_code>/',
    };
    if (steps?.length) {
      filePayload.steps = steps;
    }
    if (executionNotes?.trim()) {
      filePayload.executionNotes = executionNotes.trim();
    }

    await fs.writeFile(defPath, JSON.stringify(filePayload, null, 2), 'utf8');

    const readmePath = path.join(pkgDir, 'README.md');
    await fs.writeFile(
      readmePath,
      this.renderSkillReadme(suggestion, executionNotes),
      'utf8',
    );

    const examplePath = path.join(pkgDir, 'run.example.json');
    await fs.writeFile(
      examplePath,
      JSON.stringify(this.buildRunExample(suggestion), null, 2),
      'utf8',
    );

    return {
      pkgDir,
      skillJsonPath: defPath,
      filesWritten: [defPath, readmePath, examplePath],
    };
  }

  private async buildSuggestion(
    context: ISkillExecutionContext,
    params: any,
  ): Promise<{
    skillCode: string;
    skillName: string;
    description: string;
    parametersSchema: Record<string, unknown>;
    minModelTier: string;
  }> {
    const summary = String(params.draftSummary ?? '').trim();
    const rawCode = String(params.skillCode ?? '').trim();
    const rawName = String(params.skillName ?? '').trim();
    const skillName = rawName || this.toTitle(summary || 'Custom Skill');
    const skillCode = this.toSnake(rawCode || skillName);
    const description =
      String(params.description ?? '').trim() ||
      (summary ? `Auto-generated from request: ${summary}` : 'Custom skill');
    let parametersSchema =
      params.parametersSchema && typeof params.parametersSchema === 'object'
        ? params.parametersSchema
        : {
            type: 'object',
            properties: {},
            required: [],
          };
    const draftGroupId = String(params.draftGroupId ?? '').trim();
    if (draftGroupId) {
      const analyzed = await this.analyzeBrowserDraft(context, draftGroupId);
      if (analyzed?.isLikelyTextPostFlow) {
        parametersSchema = {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Post content text to publish.',
            },
            delayMs: {
              type: 'number',
              description: 'Optional delay between steps in milliseconds.',
              default: 1500,
            },
          },
          required: ['content'],
        };
      }
    }
    const minModelTier = String(params.minModelTier ?? 'skill')
      .trim()
      .toLowerCase();
    return {
      skillCode,
      skillName,
      description,
      parametersSchema,
      minModelTier,
    };
  }

  private async analyzeBrowserDraft(
    context: ISkillExecutionContext,
    draftGroupId: string,
  ): Promise<{ isLikelyTextPostFlow: boolean } | null> {
    const user = await this.usersService.findById(context.userId);
    const identifier = user?.identifier?.trim();
    if (!identifier) return null;
    const draftPath = path.join(
      this.workspaceService.getUserDir(identifier),
      'browser_debug',
      draftGroupId,
      'skill_draft.json',
    );
    try {
      const raw = await fs.readFile(draftPath, 'utf8');
      const parsed = JSON.parse(raw);
      const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
      const hasType = steps.some((s: any) => String(s?.action) === 'type');
      const hasPublishClick = steps.some((s: any) =>
        /đăng|post/i.test(String(s?.selector ?? '')),
      );
      return { isLikelyTextPostFlow: hasType && hasPublishClick };
    } catch {
      return null;
    }
  }

  private async getPendingFilePath(
    context: ISkillExecutionContext,
  ): Promise<string> {
    const user = await this.usersService.findById(context.userId);
    const identifier = user?.identifier?.trim();
    if (!identifier) throw new Error('User identifier is missing');
    const workspaceDir = this.workspaceService.getUserWorkspaceDir(identifier);
    return path.join(workspaceDir, 'skills_registry_pending.json');
  }

  private async writePendingSuggestion(
    context: ISkillExecutionContext,
    suggestion: {
      skillCode: string;
      skillName: string;
      description: string;
      parametersSchema: Record<string, unknown>;
      minModelTier: string;
    },
    draftGroupId?: unknown,
  ): Promise<{ suggestionId: string }> {
    const filePath = await this.getPendingFilePath(context);
    const suggestionId = crypto.randomUUID().slice(0, 12);
    const payload = {
      suggestionId,
      createdAt: new Date().toISOString(),
      draftGroupId: String(draftGroupId ?? '').trim() || null,
      suggestion,
    };
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { suggestionId };
  }

  private async readPendingSuggestion(
    context: ISkillExecutionContext,
  ): Promise<
    | {
        suggestionId: string;
        draftGroupId?: string | null;
        suggestion: {
          skillCode: string;
          skillName: string;
          description: string;
          parametersSchema: Record<string, unknown>;
          minModelTier: string;
        };
      }
    | null
  > {
    const filePath = await this.getPendingFilePath(context);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed?.suggestionId || !parsed?.suggestion) return null;
      return {
        suggestionId: String(parsed.suggestionId),
        draftGroupId: parsed.draftGroupId ?? null,
        suggestion: parsed.suggestion,
      };
    } catch {
      return null;
    }
  }

  private async getPendingSelectionFilePath(
    context: ISkillExecutionContext,
  ): Promise<string> {
    const user = await this.usersService.findById(context.userId);
    const identifier = user?.identifier?.trim();
    if (!identifier) throw new Error('User identifier is missing');
    return path.join(
      this.workspaceService.getUserWorkspaceDir(identifier),
      'skills_registry_selection.json',
    );
  }

  private async writePendingSelection(
    context: ISkillExecutionContext,
    selectedSkillCode: string,
  ): Promise<void> {
    const filePath = await this.getPendingSelectionFilePath(context);
    const payload = {
      selectedSkillCode,
      selectedAt: new Date().toISOString(),
    };
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  private async readPendingSelection(
    context: ISkillExecutionContext,
  ): Promise<{ selectedSkillCode: string } | null> {
    const filePath = await this.getPendingSelectionFilePath(context);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed?.selectedSkillCode) return null;
      return { selectedSkillCode: String(parsed.selectedSkillCode) };
    } catch {
      return null;
    }
  }

  private async findCandidates(task: string, topK: number): Promise<any[]> {
    const all = await this.listSharedSkillsFromDisk();
    const terms = String(task)
      .toLowerCase()
      .split(/[^a-z0-9\u00C0-\u024f]+/i)
      .filter(Boolean)
      .slice(0, 30);

    const scored = all.map((s) => {
      const hay = `${s.code} ${s.name} ${s.description}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (!t) continue;
        if (hay.includes(t)) score += 1;
      }
      if (score === 0 && terms.length > 0) {
        if (hay.includes(terms.join(' '))) score += 2;
      }
      return {
        skillCode: s.code,
        skillName: s.name,
        description: s.description,
        parametersSchema: s.parametersSchema ?? null,
        score,
      };
    });

    return scored
      .filter((x) => x.score > 0 || terms.length === 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
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

  /** Append executionNotes to description so list/find/run flows surface operator criteria. */
  private mergeDescriptionWithExecutionNotes(
    parsed: Record<string, unknown>,
  ): string {
    let desc = String(parsed.description ?? '');
    const en = parsed.executionNotes;
    if (typeof en === 'string' && en.trim()) {
      const t = en.trim();
      const preview = t.length > 800 ? `${t.slice(0, 800)}…` : t;
      desc += `\n\n[executionNotes]\n${preview}`;
    }
    return desc;
  }

  /** Scan $BRAIN_DIR/_shared/skills: <code>/skill.json and legacy *.skill.json */
  private async listSharedSkillsFromDisk(): Promise<
    Array<{
      code: string;
      name: string;
      description: string;
      parametersSchema: Record<string, unknown> | null;
      filePath: string;
      packageDir: string;
      legacyFlatFile?: boolean;
    }>
  > {
    const base = this.workspaceService.getSharedSkillsDir();
    const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
    const out: Array<{
      code: string;
      name: string;
      description: string;
      parametersSchema: Record<string, unknown> | null;
      filePath: string;
      packageDir: string;
      legacyFlatFile?: boolean;
    }> = [];
    const seenCodes = new Set<string>();

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const folderName = ent.name;
      if (!this.workspaceService.sanitizeSharedSkillCode(folderName)) continue;
      const defPath = path.join(base, folderName, 'skill.json');
      try {
        const raw = await fs.readFile(defPath, 'utf8');
        const parsed = JSON.parse(raw);
        const c = String(parsed.code ?? folderName).trim();
        seenCodes.add(c);
        out.push({
          code: c,
          name: String(parsed.name ?? folderName),
          description: this.mergeDescriptionWithExecutionNotes(
            parsed as Record<string, unknown>,
          ),
          parametersSchema:
            parsed.parametersSchema &&
            typeof parsed.parametersSchema === 'object'
              ? (parsed.parametersSchema as Record<string, unknown>)
              : null,
          filePath: `file://${defPath}`,
          packageDir: path.join(base, folderName),
          legacyFlatFile: false,
        });
      } catch {
        /* empty or bad dir */
      }
    }

    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.skill.json')) {
        continue;
      }
      const codeFromFile = ent.name.replace(/\.skill\.json$/i, '');
      if (seenCodes.has(codeFromFile)) continue;
      const fullPath = path.join(base, ent.name);
      try {
        const raw = await fs.readFile(fullPath, 'utf8');
        const parsed = JSON.parse(raw);
        const c = String(parsed.code ?? codeFromFile).trim();
        out.push({
          code: c,
          name: String(parsed.name ?? codeFromFile),
          description: this.mergeDescriptionWithExecutionNotes(
            parsed as Record<string, unknown>,
          ),
          parametersSchema:
            parsed.parametersSchema &&
            typeof parsed.parametersSchema === 'object'
              ? (parsed.parametersSchema as Record<string, unknown>)
              : null,
          filePath: `file://${fullPath}`,
          packageDir: path.dirname(fullPath),
          legacyFlatFile: true,
        });
      } catch {
        /* skip */
      }
    }

    return out.sort((a, b) => a.code.localeCompare(b.code));
  }

  private async loadSharedSkillDescriptor(code: string): Promise<{
    code: string;
    name: string;
    description: string;
    parametersSchema: Record<string, unknown> | null;
    filePath: string;
  } | null> {
    const trimmed = String(code ?? '').trim();
    if (!trimmed) return null;
    const s = this.workspaceService.sanitizeSharedSkillCode(trimmed);
    if (s) {
      const defPath = path.join(
        this.workspaceService.getSharedSkillsDir(),
        s,
        'skill.json',
      );
      try {
        const raw = await fs.readFile(defPath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return {
          code: String(parsed.code ?? s),
          name: String(parsed.name ?? s),
          description: this.mergeDescriptionWithExecutionNotes(parsed),
          parametersSchema:
            parsed.parametersSchema &&
            typeof parsed.parametersSchema === 'object'
              ? (parsed.parametersSchema as Record<string, unknown>)
              : null,
          filePath: `file://${defPath}`,
        };
      } catch {
        /* try legacy */
      }
    }
    const legacyPath = path.join(
      this.workspaceService.getSharedSkillsDir(),
      `${trimmed}.skill.json`,
    );
    try {
      const raw = await fs.readFile(legacyPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        code: String(parsed.code ?? trimmed),
        name: String(parsed.name ?? trimmed),
        description: this.mergeDescriptionWithExecutionNotes(parsed),
        parametersSchema:
          parsed.parametersSchema &&
          typeof parsed.parametersSchema === 'object'
            ? (parsed.parametersSchema as Record<string, unknown>)
            : null,
        filePath: `file://${legacyPath}`,
      };
    } catch {
      return null;
    }
  }

  private async findDuplicateOnDisk(suggestion: {
    skillCode: string;
    skillName: string;
    parametersSchema: Record<string, unknown>;
  }): Promise<{
    isDuplicate: boolean;
    reason?: 'skill_code' | 'skill_name_parameters_schema';
  }> {
    const code = String(suggestion.skillCode ?? '').trim();
    const s = this.workspaceService.sanitizeSharedSkillCode(code);
    if (s) {
      const pkgJson = path.join(
        this.workspaceService.getSharedSkillsDir(),
        s,
        'skill.json',
      );
      try {
        await fs.access(pkgJson);
        return { isDuplicate: true, reason: 'skill_code' };
      } catch {
        /* */
      }
    }
    const legacy = path.join(
      this.workspaceService.getSharedSkillsDir(),
      `${code}.skill.json`,
    );
    try {
      await fs.access(legacy);
      return { isDuplicate: true, reason: 'skill_code' };
    } catch {
      /* */
    }

    const name = String(suggestion.skillName ?? '').trim();
    if (name && suggestion.parametersSchema != null) {
      const target = this.stableStringify(suggestion.parametersSchema);
      const all = await this.listSharedSkillsFromDisk();
      const matched = all.find(
        (x) =>
          String(x.name ?? '').trim().toLowerCase() === name.toLowerCase() &&
          this.stableStringify(x.parametersSchema) === target,
      );
      if (matched) {
        return { isDuplicate: true, reason: 'skill_name_parameters_schema' };
      }
    }
    return { isDuplicate: false };
  }

  private formatDuplicateSkillError(
    skillCode: string,
    duplicate: {
      isDuplicate: boolean;
      reason?: 'skill_code' | 'skill_name_parameters_schema';
    },
  ): string {
    const code = String(skillCode ?? '').trim();
    if (duplicate.reason === 'skill_code') {
      return (
        `Duplicate skill_code: "${code}" already exists under ${this.workspaceService
          .getSharedSkillsDir()
          .replace(/\\/g, '/')}/. ` +
        `If the user asked to RUN/chạy/thực thi the skill, use action=run_skill with skillCode="${code}" and runtimeParams (e.g. {"content":"..."}) — do NOT call bootstrap_skill. ` +
        `To REPLACE the package on disk with a new definition, call bootstrap_skill (or create) with overwriteExisting=true and confirmCreate=true.`
      );
    }
    return (
      'Duplicate skill_name + parameters_schema: same task already exists on disk. ' +
      'Use a different skillCode/skillName or overwriteExisting=true if replacing the folder.'
    );
  }

  /**
   * Gọi LLM gắn nhãn B1… / userRequestedSteps vào skill_draft trước khi đọc steps (bootstrap_skill / create).
   */
  private async maybeEnrichDraftBeforeBootstrap(
    context: ISkillExecutionContext,
    params: Record<string, unknown>,
    draftGroupId: string,
  ): Promise<void> {
    const aiEnrich =
      params.aiEnrichDraft === true ||
      String(params.aiEnrichDraft ?? '').toLowerCase() === 'true';
    if (!draftGroupId || !aiEnrich) return;
    const user = await this.usersService.findById(context.userId);
    const identifier = user?.identifier?.trim();
    if (!identifier) return;
    const force =
      params.aiEnrichDraftForce === true ||
      String(params.aiEnrichDraftForce ?? '').toLowerCase() === 'true';
    const ur = String(params.userRequest ?? '').trim() || undefined;
    await this.skillDraftEnrichment
      .applyEnrichmentToDraftFile(context.userId, identifier, draftGroupId, {
        userRequest: ur,
        force,
      })
      .catch(() => undefined);
  }

  private async extractStepsFromDraft(
    context: ISkillExecutionContext,
    draftGroupId: string,
  ): Promise<any[] | null> {
    const user = await this.usersService.findById(context.userId);
    const identifier = user?.identifier?.trim();
    if (!identifier || !draftGroupId) return null;
    const draftPath = path.join(
      this.workspaceService.getUserDir(identifier),
      'browser_debug',
      draftGroupId,
      'skill_draft.json',
    );
    try {
      const raw = await fs.readFile(draftPath, 'utf8');
      const parsed = JSON.parse(raw);
      const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
      return steps.length ? steps : null;
    } catch {
      return null;
    }
  }

  /**
   * Đọc ghi chú vận hành / tiêu chí thành công từ file nháp (trước khi bootstrap).
   * Cho phép thêm vào skill_draft.json các key: executionNotes, successCriteria, operatorInstructions, userRequestedSteps, userRequest.
   */
  private async readExecutionNotesFromDraftFile(
    context: ISkillExecutionContext,
    draftGroupId: string,
  ): Promise<string | null> {
    const user = await this.usersService.findById(context.userId);
    const identifier = user?.identifier?.trim();
    if (!identifier || !draftGroupId) return null;
    const draftPath = path.join(
      this.workspaceService.getUserDir(identifier),
      'browser_debug',
      draftGroupId,
      'skill_draft.json',
    );
    try {
      const raw = await fs.readFile(draftPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const chunks: string[] = [];
      for (const k of [
        'executionNotes',
        'successCriteria',
        'operatorInstructions',
        'userRequestedSteps',
      ]) {
        const v = parsed[k];
        if (typeof v === 'string' && v.trim()) chunks.push(v.trim());
      }
      if (typeof parsed.userRequest === 'string' && parsed.userRequest.trim()) {
        chunks.push(`Yêu cầu gốc (user):\n${parsed.userRequest.trim()}`);
      }
      return chunks.length ? chunks.join('\n\n') : null;
    } catch {
      return null;
    }
  }

  /** Gộp executionNotes từ tham số bootstrap + file nháp (không lặp draftSummary vào đây — đã dùng cho description). */
  private async mergeExecutionNotesFromParamsAndDraft(
    context: ISkillExecutionContext,
    params: Record<string, unknown>,
    draftGroupId: string,
  ): Promise<string | undefined> {
    const fromParams = String(params.executionNotes ?? '').trim();
    const fromDraft = draftGroupId
      ? await this.readExecutionNotesFromDraftFile(context, draftGroupId)
      : null;
    const parts = [fromParams, fromDraft].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
    if (!parts.length) return undefined;
    return parts.join('\n\n---\n\n');
  }

  /**
   * When skill JSON has no `steps`, infer a minimal Playwright flow from schema + description.
   * Currently supports Facebook text post when `content` is in parameters schema.
   */
  private inferDefaultStepsFromSkillFile(fileJson: any, skillRow: any): any[] {
    const schema = fileJson?.parametersSchema ?? skillRow?.parametersSchema;
    const props =
      schema && typeof schema === 'object' && schema.properties
        ? (schema.properties as Record<string, unknown>)
        : {};
    const hasContent = Boolean(props?.content);
    const hay = `${String(fileJson?.description ?? '')} ${String(skillRow?.description ?? '')} ${String(skillRow?.code ?? '')} ${String(fileJson?.code ?? '')}`.toLowerCase();
    const looksFacebook =
      hay.includes('facebook') || /\bfb\b/.test(hay) || hay.includes('meta');
    if (hasContent && looksFacebook) {
      // www.facebook.com (desktop) + cookie → reload → evaluate login → m.facebook.com/composer/ (mobile, load cookies again) → type → Đăng + verify.
      return [
        {
          action: 'navigate',
          url: 'https://www.facebook.com/',
          loadCookiesForUrl: true,
          useMobileContext: false,
          waitMs: 2500,
          selectorTimeoutMs: 30000,
        },
        {
          action: 'navigate',
          url: 'https://www.facebook.com/',
          loadCookiesForUrl: false,
          useMobileContext: false,
          waitMs: 2000,
          selectorTimeoutMs: 30000,
        },
        {
          action: 'evaluate',
          script:
            "(() => { const u = (location.href || '').toLowerCase(); if (u.includes('login') || u.includes('checkpoint') || u.includes('recover')) throw new Error('Facebook: vẫn ở trang đăng nhập hoặc bảo mật — cookie không hợp lệ hoặc hết hạn.'); if (document.querySelector('input[type=password]')) throw new Error('Facebook: còn form đăng nhập — chưa đăng nhập.'); return true; })()",
        },
        {
          action: 'navigate',
          url: 'https://m.facebook.com/composer/',
          loadCookiesForUrl: true,
          useMobileContext: true,
          waitMs: 3000,
          selectorTimeoutMs: 35000,
        },
        {
          action: 'type',
          selector:
            '[aria-label*="Bạn đang nghĩ gì"][role="textbox"], [aria-label*="What\'s on your mind"][role="textbox"], div[role="textbox"], div[contenteditable="true"][role="textbox"], div[contenteditable="true"]',
          text: '$content',
          textHints: ['Bạn đang nghĩ gì', "What's on your mind"],
          waitMs: 2000,
          selectorTimeoutMs: 25000,
        },
        {
          action: 'click',
          selector:
            'div[role="button"]:has-text("Đăng"), button:has-text("Đăng"), div[role="button"]:has-text("Post"), button:has-text("Post"), [role="button"][aria-label*="Đăng"], [role="button"][aria-label*="Post"]',
          waitMs: 2500,
          selectorTimeoutMs: 35000,
          skipPublishVerification: false,
        },
      ];
    }
    return [];
  }

  /**
   * Khi run_skill thất bại: chép snapshot/HTML từ OS temp → $BRAIN_DIR/.../browser_debug/<id>/,
   * ghi skill_draft.json (steps template + runStepLogs) để agent dùng draftGroupId với bootstrap_skill.
   */
  private async promoteSkillRunFailureArtifacts(
    context: ISkillExecutionContext,
    opts: {
      tempDir: string;
      skillCode: string;
      skillName: string;
      stepsTemplate: any[];
      runLogs: any[];
      error: string;
      userRequest?: string;
      aiEnrichOnFailure?: boolean;
    },
  ): Promise<{
    draftGroupId: string;
    preservedUnder: string;
    skillDraftRelative: string;
    hint: string;
  } | null> {
    const user = await this.usersService.findById(context.userId);
    const identifier = user?.identifier?.trim();
    if (!identifier) return null;

    let hasFiles = false;
    try {
      const list = await fs.readdir(opts.tempDir);
      hasFiles = list.length > 0;
    } catch {
      return null;
    }
    if (!hasFiles) return null;

    const draftGroupId = crypto.randomBytes(8).toString('hex').slice(0, 16);
    const destDir = path.join(
      this.workspaceService.getUserDir(identifier),
      'browser_debug',
      draftGroupId,
    );
    await fs.mkdir(destDir, { recursive: true });

    const entries = await fs.readdir(opts.tempDir, { withFileTypes: true });
    if (entries.length === 1 && entries[0].isDirectory()) {
      await fs.cp(
        path.join(opts.tempDir, entries[0].name),
        destDir,
        { recursive: true },
      );
    } else {
      await fs.cp(opts.tempDir, destDir, { recursive: true });
    }

    const stepsForDraft = Array.isArray(opts.stepsTemplate)
      ? opts.stepsTemplate.map((s) =>
          s && typeof s === 'object' ? { ...s } : s,
        )
      : [];

    const draftPayload: Record<string, unknown> = {
      groupId: draftGroupId,
      identifier: opts.skillCode || 'shared_skill',
      sharedSkillTune: true,
      sharedSkillCode: opts.skillCode,
      sharedSkillName: opts.skillName,
      source: 'run_skill_failure',
      createdAt: new Date().toISOString(),
      failureError: opts.error,
      runStepLogs: opts.runLogs,
      steps: stepsForDraft,
      summary: {
        total: opts.runLogs.length,
        passed: opts.runLogs.filter((x) => x?.success).length,
        failed: opts.runLogs.filter((x) => !x?.success).length,
      },
    };
    if (typeof opts.userRequest === 'string' && opts.userRequest.trim()) {
      draftPayload.userRequest = opts.userRequest.trim();
    }

    await fs.writeFile(
      path.join(destDir, 'skill_draft.json'),
      JSON.stringify(draftPayload, null, 2),
      'utf8',
    );

    const wantAi =
      opts.aiEnrichOnFailure !== false &&
      String(opts.aiEnrichOnFailure ?? 'true').toLowerCase() !== 'false';
    if (wantAi) {
      await this.skillDraftEnrichment
        .applyEnrichmentToDraftFile(context.userId, identifier, draftGroupId, {
          userRequest: opts.userRequest?.trim(),
          force: false,
        })
        .catch(() => undefined);
    }

    /** Nền: gộp selector từ runStepLogs → $BRAIN_DIR/<user>/browser_dom_presets/<domain>.json (không chặn bootstrap). */
    this.browserDomPresetLearnService.scheduleLearnFromBrowserDebugDraft(
      destDir,
      identifier,
    );

    await fs.rm(opts.tempDir, { recursive: true, force: true }).catch(() => {});

    const preservedUnder = `${path
      .join(
        this.workspaceService.getUserDir(identifier),
        'browser_debug',
        draftGroupId,
      )
      .replace(/\\/g, '/')}/`;
    const hint =
      `Đã giữ snapshot/HTML dưới ${preservedUnder}. ` +
      `Cập nhật từ draft: \`bootstrap_skill\` + \`confirmCreate=true\` + \`draftGroupId="${draftGroupId}"\` + \`skillCode=...\`; ` +
      `nếu giữ nguyên mã \`${opts.skillCode}\` thì thêm \`overwriteExisting=true\`. Chạy lại: \`run_skill\`.`;

    return {
      draftGroupId,
      preservedUnder,
      skillDraftRelative: `${preservedUnder}skill_draft.json`,
      hint,
    };
  }

  private async executeDbSkillFile(
    context: ISkillExecutionContext,
    skill: any,
    runtimeParams: Record<string, unknown>,
  ): Promise<{
    success: boolean;
    error?: string;
    steps?: any[];
    skillTune?: {
      draftGroupId: string;
      preservedUnder: string;
      skillDraftRelative: string;
      hint: string;
    };
  }> {
    const rawPath = String(skill.filePath ?? '').trim();
    const absPath = rawPath.startsWith('file://')
      ? rawPath.replace(/^file:\/\//, '')
      : rawPath;
    if (!absPath) return { success: false, error: 'Skill file_path is empty' };

    let parsed: any;
    try {
      parsed = JSON.parse(await fs.readFile(absPath, 'utf8'));
    } catch (err: any) {
      return {
        success: false,
        error: `Cannot read skill file: ${err?.message ?? String(err)}`,
      };
    }

    let steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
    if (!steps.length) {
      const inferred = this.inferDefaultStepsFromSkillFile(parsed, skill);
      if (inferred.length) {
        steps = inferred;
      } else {
        return {
          success: false,
          error:
            'Skill file has no "steps" and could not infer a browser flow. Add a "steps" array or a parametersSchema with "content" for Facebook text post skills.',
        };
      }
    }

    runtimeParams = this.applyModePresetToRuntimeParams(parsed, runtimeParams);

    const persistArtifactsOnFailure =
      runtimeParams.persistArtifactsOnFailure !== false &&
      runtimeParams.persistArtifactsOnFailure !== 'false';

    const runLogs: any[] = [];
    let runOutcome: {
      success: boolean;
      error?: string;
      steps?: any[];
      skillTune?: {
        draftGroupId: string;
        preservedUnder: string;
        skillDraftRelative: string;
        hint: string;
      };
    } = { success: true, steps: runLogs };

    const debugRun =
      runtimeParams.debug === true ||
      runtimeParams.debug === 'true' ||
      String(runtimeParams.debug ?? '').toLowerCase() === 'true';

    try {
      for (const step of steps) {
        const rawParams =
          step && typeof step === 'object' ? { ...step } : ({} as any);
        const optional = rawParams.optional === true;
        const stepToolCode = String(rawParams.tool ?? '').trim().toLowerCase();
        const whenAnyParams = Array.isArray(rawParams.whenAnyParams)
          ? (rawParams.whenAnyParams as unknown[])
              .map((x) => String(x ?? '').trim())
              .filter(Boolean)
          : [];
        const stepCapture =
          rawParams.capture && typeof rawParams.capture === 'object'
            ? ({ ...rawParams.capture } as Record<string, unknown>)
            : null;
        delete rawParams.action;
        delete rawParams.optional;
        delete rawParams.tool;
        delete rawParams.whenAnyParams;
        delete rawParams.capture;
        if (whenAnyParams.length > 0) {
          const hasAny = whenAnyParams.some((k) => {
            const v = runtimeParams[k];
            if (v == null) return false;
            if (typeof v === 'string') return v.trim().length > 0;
            if (Array.isArray(v)) return v.length > 0;
            return true;
          });
          if (!hasAny) {
            runLogs.push({
              tool: stepToolCode || 'browser',
              action: String(step?.action ?? '').trim() || undefined,
              optional: true,
              success: true,
              skipped: true,
              reason: `whenAnyParams not satisfied: ${whenAnyParams.join(',')}`,
            });
            continue;
          }
        }
        const resolvedParams =
          this.resolveTemplateValue(rawParams, runtimeParams) as Record<
            string,
            unknown
          >;
        const browserAction = String(step?.action ?? '').trim();
        const skillCode = stepToolCode || (browserAction ? 'browser' : '');
        if (!skillCode) continue;
        if (skillCode === 'browser' && !browserAction) {
          runLogs.push({
            tool: 'browser',
            optional,
            success: false,
            error: 'Missing browser action',
          });
          if (!optional) {
            runOutcome = {
              success: false,
              error: 'Missing browser action in step',
              steps: runLogs,
            };
            break;
          }
          continue;
        }

        const executeParams =
          skillCode === 'browser'
            ? {
                action: browserAction,
                ...resolvedParams,
                ...(debugRun ? { saveOnError: true } : {}),
                // Production skill runs: snapshots/HTML in OS temp only, no BRAIN_DIR skill_draft.
                browserDebugScope: 'temp',
              }
            : resolvedParams;

        const result = await this.skillsService.executeSkill(skillCode, {
          userId: context.userId,
          threadId: context.threadId,
          runId: context.runId,
          actorTelegramId: context.actorTelegramId,
          parameters: executeParams,
        });
        const data = (result as any)?.data;
        const art = data?.debugArtifacts;
        if ((result as any)?.success && stepCapture) {
          for (const [varName, fromPath] of Object.entries(stepCapture)) {
            if (!varName) continue;
            const p = String(fromPath ?? '').trim();
            if (!p) continue;
            const val = this.getByPath({ data, result }, p);
            if (val !== undefined) {
              runtimeParams[varName] = val;
            }
          }
        }
        runLogs.push({
          tool: skillCode,
          action: browserAction || undefined,
          optional,
          success: Boolean((result as any)?.success),
          error: (result as any)?.error,
          currentUrl:
            typeof data?.currentUrl === 'string'
              ? data.currentUrl
              : undefined,
          usedSelector:
            typeof data?.usedSelector === 'string'
              ? data.usedSelector
              : undefined,
          verifyReason:
            typeof data?.verifyReason === 'string'
              ? data.verifyReason
              : undefined,
          ...(debugRun && data
            ? {
                cookieOrDebug: {
                  cookieUserIdentifier: data.cookieUserIdentifier,
                  cookieLoad: data.cookieLoad,
                  verifyReason: data.verifyReason,
                  skillDraftGroupId: data.skillDraftGroupId,
                  ...(art
                    ? {
                        screenshotPath: art.screenshotPath,
                        htmlPath: art.htmlPath,
                        groupId: art.groupId,
                      }
                    : {}),
                },
              }
            : {}),
        });
        if (!(result as any)?.success) {
          if (optional) {
            continue;
          }
          runOutcome = {
            success: false,
            error:
              (result as any)?.error ??
              `Step failed: ${skillCode}${browserAction ? `/${browserAction}` : ''}`,
            steps: runLogs,
          };
          break;
        }
      }
    } finally {
      const tempDir = getMiraBrowserTempBaseDir({
        userId: context.userId,
        runId: context.runId,
        threadId: context.threadId,
      });
      if (runOutcome.success) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      } else {
        let cleaned = false;
        if (persistArtifactsOnFailure) {
          const ur =
            typeof runtimeParams.userRequest === 'string'
              ? runtimeParams.userRequest.trim()
              : '';
          const aiEnrichOnFailure =
            runtimeParams.aiEnrichOnFailure !== false &&
            runtimeParams.aiEnrichOnFailure !== 'false';
          const tune = await this.promoteSkillRunFailureArtifacts(context, {
            tempDir,
            skillCode: String(skill.code ?? '').trim(),
            skillName: String(skill.name ?? '').trim(),
            stepsTemplate: steps,
            runLogs,
            error: runOutcome.error ?? 'unknown',
            ...(ur ? { userRequest: ur } : {}),
            aiEnrichOnFailure,
          });
          if (tune) {
            runOutcome.skillTune = tune;
            cleaned = true;
          }
        }
        if (!cleaned) {
          await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    return runOutcome;
  }

  private fileUrlToPath(fileUrl: string): string {
    const s = String(fileUrl ?? '').trim();
    return s.startsWith('file://') ? s.replace(/^file:\/\//, '') : s;
  }

  private getByPath(input: unknown, pathExpr: string): unknown {
    const parts = String(pathExpr ?? '')
      .split('.')
      .map((x) => x.trim())
      .filter(Boolean);
    let cur: any = input;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  }

  private resolveTemplateValue(
    value: unknown,
    runtimeParams: Record<string, unknown>,
  ): unknown {
    if (typeof value === 'string') {
      const exact = value.match(/^\$([a-zA-Z0-9_]+)$/);
      if (exact) return runtimeParams[exact[1]];
      return value.replace(/\$([a-zA-Z0-9_]+)/g, (_m, key) => {
        const rv = runtimeParams[key];
        return rv == null ? '' : String(rv);
      });
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.resolveTemplateValue(v, runtimeParams));
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.resolveTemplateValue(v, runtimeParams);
      }
      return out;
    }
    return value;
  }

  private applyModePresetToRuntimeParams(
    parsedSkillFile: any,
    runtimeParams: Record<string, unknown>,
  ): Record<string, unknown> {
    const mode = String(runtimeParams.mode ?? '').trim();
    if (!mode) return runtimeParams;
    const presets =
      parsedSkillFile?.modePresets && typeof parsedSkillFile.modePresets === 'object'
        ? (parsedSkillFile.modePresets as Record<string, unknown>)
        : null;
    if (!presets) return runtimeParams;
    const presetRaw = presets[mode];
    if (!presetRaw || typeof presetRaw !== 'object' || Array.isArray(presetRaw)) {
      return runtimeParams;
    }
    const preset = presetRaw as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...runtimeParams };
    for (const [k, v] of Object.entries(preset)) {
      const existing = merged[k];
      if (existing === undefined || existing === null || existing === '') {
        merged[k] = v;
        continue;
      }
      if (
        existing &&
        typeof existing === 'object' &&
        !Array.isArray(existing) &&
        v &&
        typeof v === 'object' &&
        !Array.isArray(v)
      ) {
        merged[k] = this.deepMergeSkillJson(
          v as Record<string, unknown>,
          existing as Record<string, unknown>,
        );
      }
    }
    return merged;
  }

  /** Merge patch vào skill.json: object lồng nhau merge đệ quy; array / scalar từ patch thay thế. */
  private deepMergeSkillJson(
    base: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null) {
        delete out[k];
        continue;
      }
      if (Array.isArray(v)) {
        out[k] = v;
        continue;
      }
      if (typeof v === 'object') {
        const prev = out[k];
        if (prev && typeof prev === 'object' && !Array.isArray(prev)) {
          out[k] = this.deepMergeSkillJson(
            prev as Record<string, unknown>,
            v as Record<string, unknown>,
          );
        } else {
          out[k] = v;
        }
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  /** Xóa `$BRAIN_DIR/_shared/skills/<code>/` hoặc file legacy `<code>.skill.json`. */
  private async deleteSharedSkillFromDisk(skillCode: string): Promise<string[]> {
    const trimmed = String(skillCode).trim();
    const s = this.workspaceService.sanitizeSharedSkillCode(trimmed);
    const base = this.workspaceService.getSharedSkillsDir();
    const removed: string[] = [];
    if (s) {
      const pkgDir = path.join(base, s);
      try {
        const st = await fs.stat(pkgDir);
        if (st.isDirectory()) {
          await fs.rm(pkgDir, { recursive: true, force: true });
          removed.push(pkgDir);
          return removed;
        }
      } catch {
        /* not a dir */
      }
    }
    const legacy = path.join(base, `${trimmed}.skill.json`);
    try {
      await fs.unlink(legacy);
      removed.push(legacy);
      return removed;
    } catch {
      throw new Error(
        `Skill not found: "${trimmed}" (expected folder ${this.workspaceService
          .getSharedSkillsDir()
          .replace(/\\/g, '/')}/<code>/ or <code>.skill.json)`,
      );
    }
  }

  private async applyPatchToSharedSkillJson(
    context: ISkillExecutionContext,
    skillCode: string,
    patch: Record<string, unknown>,
    regenerateReadme: boolean,
  ): Promise<{
    skillJsonPath: string;
    mergedKeys: string[];
    readmeUpdated?: boolean;
  }> {
    const desc = await this.loadSharedSkillDescriptor(skillCode);
    if (!desc) {
      throw new Error(`Skill not found: ${skillCode}`);
    }
    const absPath = this.fileUrlToPath(desc.filePath);
    const raw = await fs.readFile(absPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const merged = this.deepMergeSkillJson(parsed, patch);
    merged.updatedAt = new Date().toISOString();
    merged.updatedByUserId = context.userId;
    await fs.writeFile(absPath, JSON.stringify(merged, null, 2), 'utf8');
    const mergedKeys = Object.keys(patch);

    let readmeUpdated: boolean | undefined;
    const isPackageLayout = path.basename(absPath) === 'skill.json';
    if (regenerateReadme && isPackageLayout) {
      const pkgDir = path.dirname(absPath);
      const readmePath = path.join(pkgDir, 'README.md');
      const suggestion = {
        skillCode: String(merged.code ?? skillCode),
        skillName: String(merged.name ?? skillCode),
        description: String(merged.description ?? ''),
      };
      const en =
        typeof merged.executionNotes === 'string'
          ? merged.executionNotes
          : undefined;
      await fs.writeFile(
        readmePath,
        this.renderSkillReadme(suggestion, en),
        'utf8',
      );
      readmeUpdated = true;
    }

    return {
      skillJsonPath: absPath,
      mergedKeys,
      readmeUpdated,
    };
  }

  private toSnake(input: string): string {
    const s = String(input ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return s || 'custom_skill';
  }

  private toTitle(input: string): string {
    const words = String(input ?? '')
      .trim()
      .replace(/[_-]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8)
      .map((w) => w[0].toUpperCase() + w.slice(1));
    return words.join(' ') || 'Custom Skill';
  }
}
