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
import { promises as fs, existsSync, statSync } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getMiraBrowserTempBaseDir } from '../../mira-browser-temp-path';
import { UsersService } from '../../../../modules/users/users.service';
import { WorkspaceService } from '../../../../gateway/workspace/workspace.service';

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'navigate',
        'screenshot',
        'snapshot',
        'snapshot_save',
        'click',
        'type',
        'scroll',
        'evaluate',
        'pdf',
        'status',
        'cookies_load',
        'cookies_save',
      ],
      description: 'Browser action to perform',
    },
    url: { type: 'string', description: 'URL to navigate to' },
    domain: {
      type: 'string',
      description:
        'Cookie domain key (used to map $BRAIN_DIR/<identifier>/cookies/<domain>.json)',
    },
    cookieFilePath: {
      type: 'string',
      description:
        'Optional absolute cookie JSON file path. If provided it overrides identifier+domain mapping.',
    },
    loadCookiesForUrl: {
      type: 'boolean',
      description:
        'If true, attempt to load cookies from $BRAIN_DIR/<identifier>/cookies/<domain>.json (before navigation).',
      default: true,
    },
    saveCookiesAfterNavigation: {
      type: 'boolean',
      description:
        'If true, save current cookies to $BRAIN_DIR/<identifier>/cookies/<domain>.json after navigation.',
      default: false,
    },
    autoSaveCookiesOnLoginSuccess: {
      type: 'boolean',
      description:
        'Auto-save cookies when login is detected as successful (optimized for facebook.com).',
      default: true,
    },
    useMobileContext: {
      type: 'boolean',
      description:
        'On navigate: recreate browser context with mobile emulation (mobile UA + viewport + touch) before goto(url).',
      default: false,
    },
    mobileViewportWidth: {
      type: 'number',
      description:
        'On navigate with useMobileContext=true: viewport width (default 390).',
      default: 390,
    },
    mobileViewportHeight: {
      type: 'number',
      description:
        'On navigate with useMobileContext=true: viewport height (default 844).',
      default: 844,
    },
    mobileUserAgent: {
      type: 'string',
      description:
        'On navigate with useMobileContext=true: custom mobile UA string. Defaults to iPhone Safari.',
    },
    selector: {
      type: 'string',
      description: 'CSS selector for click/type actions',
    },
    textHints: {
      type: 'array',
      description:
        'Optional exact text hints (usually extracted from quoted user phrases) to prioritize element matching.',
      items: { type: 'string' },
    },
    text: { type: 'string', description: 'Text to type' },
    script: { type: 'string', description: 'JavaScript to evaluate in page' },
    identifier: {
      type: 'string',
      description:
        'Task/account identifier used to group debug artifacts (for later cleanup)',
    },
    debugBaseDir: {
      type: 'string',
      description:
        'Base dir to store browser debug artifacts (absolute path recommended)',
    },
    saveOnError: {
      type: 'boolean',
      description: 'Save HTML + screenshot when an action fails',
      default: true,
    },
    autoRetryOnFailure: {
      type: 'boolean',
      description:
        'On click/type failure, retry with textHints + per-domain preset file `$BRAIN_DIR/_shared/browser_dom_presets/<domain>.json` (only matching domain is read; mtime-cached) + heuristics from HTML snapshot; Facebook falls back to built-in lists if file missing.',
      default: true,
    },
    maxSnapshotsPerGroup: {
      type: 'number',
      description: 'Limit number of html snapshots kept per artifact group',
      default: 5,
    },
    fullPage: {
      type: 'boolean',
      description: 'Full page screenshot',
      default: true,
    },
    waitMs: {
      type: 'number',
      description: 'Wait time in ms after action',
      default: 1000,
    },
    selectorTimeoutMs: {
      type: 'number',
      description:
        'Max wait for selector in ms (click/type). Default 12000. Max 120000.',
      default: 12000,
    },
    skipPublishVerification: {
      type: 'boolean',
      description:
        'For Facebook publish-like clicks: skip post-publish body text verification (use if UI toasts differ from built-in heuristics).',
      default: false,
    },
    browserDebugScope: {
      type: 'string',
      enum: ['heart', 'temp'],
      description:
        'heart (default, scope name): persist browser_debug + skill_draft under $BRAIN_DIR/<user>/ for research & skill authoring. ' +
        'temp: snapshots/HTML under OS temp (mira-browser/u<userId>/<run|thread>/…), no skill_draft — isolated per user.',
      default: 'heart',
    },
  },
  required: ['action'],
};

/** Parsed `$BRAIN_DIR/.../browser_dom_presets/<domain>.json` — shared + per-user override. */
type BrowserDomPublishVerificationConfig = {
  /** Set false to skip post-click verification for this domain (editable without deploy). */
  enabled?: boolean;
  bodyTextContains?: string[];
  liveRegionTextContains?: string[];
  /** If composer UI is gone, treat publish as OK (default true). */
  assumeSuccessWhenComposerClosed?: boolean;
  composerDialogSelectors?: string[];
  liveRegionSelectors?: string[];
  /** Delays between polls (ms). Default ~[2000,1500,1500,1500]. */
  pollDelaysMs?: number[];
  maxPollAttempts?: number;
};

type BrowserDomLoginSuccessConfig = {
  /** Regex string tested against `document.cookie` (e.g. `c_user=`). */
  sessionCookiePattern?: string;
  /** Any selector match ⇒ logged-in shell visible. */
  domSelectors?: string[];
};

type BrowserDomRetryGuardsConfig = {
  /** Substrings in selector/hints meaning “open composer” (case-insensitive). */
  composerOpenSubstrings?: string[];
  /** Regex strings: retry candidate skipped when opening composer (e.g. avoid hitting Đăng). */
  composerStepDenyCandidatePatterns?: string[];
  /** Regex strings tested against the selector string for “publish” clicks (per-site). */
  publishIntentSelectorPatterns?: string[];
};

type BrowserDomPresetDomainEntry = {
  version?: number;
  click?: string[];
  type?: string[];
  /** Small wheel nudge before retry candidates (sticky UI). */
  scrollAssistBeforeRetry?: boolean;
  publishVerification?: BrowserDomPublishVerificationConfig;
  loginSuccess?: BrowserDomLoginSuccessConfig;
  retryGuards?: BrowserDomRetryGuardsConfig;
};

/** In-code fallback only when JSON omits fields (prefer editing `browser_dom_presets/<domain>.json`). */
const MINIMAL_PUBLISH_VERIFICATION_FALLBACK: BrowserDomPublishVerificationConfig = {
  bodyTextContains: [],
  liveRegionTextContains: [],
  assumeSuccessWhenComposerClosed: true,
  composerDialogSelectors: [
    '[role="dialog"] div[role="textbox"]',
    '[role="dialog"] [contenteditable="true"]',
  ],
  liveRegionSelectors: [
    '[role="alert"]',
    '[aria-live]',
    '[data-testid*="toast"]',
  ],
  pollDelaysMs: [2000, 1500, 1500, 1500],
};

@RegisterSkill({
  code: 'browser',
  name: 'Browser Control',
  description:
    'Control a headless browser via Playwright. ' +
    'Can navigate to URLs, take screenshots, click elements, type text, ' +
    'scroll pages, evaluate JavaScript, and generate PDFs. ' +
    'Use for web scraping, testing, form filling, and visual verification. ' +
    'Supports loading/saving cookies via `cookies_load` / `cookies_save` and ' +
    'maps cookies to `$BRAIN_DIR/<identifier>/cookies/<domain>.json`. ' +
    'For `navigate`: `loadCookiesForUrl` defaults true, `saveCookiesAfterNavigation` defaults false, and login-success can auto-save cookies by domain. ' +
    '`browserDebugScope=heart` (default) persists skill_draft under $BRAIN_DIR; `temp` uses OS temp for snapshots only (e.g. _shared skill runs).',
  category: SkillCategory.BROWSER,
  parametersSchema: PARAMETERS_SCHEMA,
  ownerOnly: true,
  minModelTier: ModelTier.SKILL,
})
@Injectable()
export class BrowserSkill implements ISkillRunner {
  private readonly logger = new Logger(BrowserSkill.name);
  private browser: any = null;
  private page: any = null;
  private context: any = null;

  private readonly fallbackDebugBaseDir = path.resolve(
    process.cwd(),
    'src/storage/browser_debug',
  );

  /** Per `<domain>` basename: file mtime → parsed entry. */
  private readonly domPresetFileCache = new Map<
    string,
    { mtimeMs: number; entry: BrowserDomPresetDomainEntry }
  >();

  /**
   * Mutex: BrowserSkill là NestJS singleton, nên page/context là shared state.
   * Serialise tất cả browser ops để tránh 2 task tranh nhau cùng 1 page.
   */
  private browserBusy = false;
  private readonly browserQueue: Array<() => void> = [];

  constructor(
    private readonly usersService: UsersService,
    private readonly workspaceService: WorkspaceService,
  ) {}

  /**
   * Chờ lấy browser lock. Trả về true nếu thành công, false nếu timeout.
   * maxWaitMs mặc định 90s (đủ cho 1 browser op điển hình hoàn thành).
   */
  private async acquireBrowserLock(maxWaitMs = 90_000): Promise<boolean> {
    if (!this.browserBusy) {
      this.browserBusy = true;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.browserQueue.indexOf(notify);
        if (idx !== -1) this.browserQueue.splice(idx, 1);
        resolve(false);
      }, maxWaitMs);
      const notify = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      this.browserQueue.push(notify);
    });
  }

  private releaseBrowserLock(): void {
    const next = this.browserQueue.shift();
    if (next) {
      next();
    } else {
      this.browserBusy = false;
    }
  }

  get definition(): ISkillDefinition {
    return {
      code: 'browser',
      name: 'Browser Control',
      description: 'Control a headless browser via Playwright',
      category: SkillCategory.BROWSER,
      type: SkillType.CODE,
      parametersSchema: PARAMETERS_SCHEMA,
      ownerOnly: true,
      minModelTier: ModelTier.SKILL,
    };
  }

  private sanitizeForFilename(input: string): string {
    const s = String(input ?? '')
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 64);
    return s || 'unknown';
  }

  private computeArtifactGroupId(threadId: string, identifier?: string) {
    const id = this.sanitizeForFilename(identifier || 'no-identifier');
    const input = `thread:${threadId}:id:${id}`;
    const sha = crypto.createHash('sha1').update(input).digest('hex');
    // 16 chars: đủ để tránh trùng + ngắn cho user
    return sha.slice(0, 16);
  }

  /**
   * Gom cùng một "trang" dù URL khác nhẹ (www, slash, http/https).
   * Khi không có runId, dùng key này để tránh tách nhóm oan.
   */
  private normalizeArtifactGroupKey(raw: string): string {
    const s = String(raw ?? '').trim();
    if (!s || s === 'unknown') return 'unknown';
    try {
      let toParse = s;
      if (!/^https?:\/\//i.test(toParse)) {
        if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}([/:?#].*)?$/i.test(toParse)) {
          toParse = 'https://' + toParse.replace(/^\/+/, '');
        } else {
          return s.toLowerCase();
        }
      }
      const u = new URL(toParse);
      let host = u.hostname.toLowerCase();
      if (host.startsWith('www.')) host = host.slice(4);
      let path = u.pathname || '';
      if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
      return path && path !== '/' ? `${host}${path}` : host;
    } catch {
      return s.toLowerCase();
    }
  }

  private async ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  private async limitSnapshotsInGroup(
    groupDir: string,
    maxSnapshotsPerGroup: number,
  ): Promise<void> {
    try {
      const files = await fs.readdir(groupDir);
      const htmlFiles = files.filter((f) => f.startsWith('snapshot_') && f.endsWith('.html'));
      if (htmlFiles.length <= maxSnapshotsPerGroup) return;

      // snapshot_<ts>__<uuid>.html => sort by filename (ts prefix)
      htmlFiles.sort((a, b) => a.localeCompare(b));
      const toRemove = htmlFiles.slice(0, htmlFiles.length - maxSnapshotsPerGroup);
      await Promise.all(
        toRemove.map(async (htmlName) => {
          const htmlPath = path.join(groupDir, htmlName);
          const pngName = htmlName.replace(/\.html$/i, '.png');
          const pngPath = path.join(groupDir, pngName);
          await fs.unlink(htmlPath).catch(() => undefined);
          await fs.unlink(pngPath).catch(() => undefined);
        }),
      );
    } catch {
      // best-effort, don't fail the whole browser skill
    }
  }

  private async saveDebugArtifacts(opts: {
    groupDir: string;
    groupId: string;
    identifier?: string;
    createdByUserId: number;
    url?: string;
    action: string;
    selector?: string;
    text?: string;
    errorMessage?: string;
    html?: string;
    screenshotFullPage?: boolean;
    maxSnapshotsPerGroup: number;
  }): Promise<{
    groupId: string;
    htmlPath?: string;
    screenshotPath?: string;
    metaPath: string;
  }> {
    const {
      groupDir,
      groupId,
      identifier,
      createdByUserId,
      url,
      action,
      selector,
      text,
      errorMessage,
      html,
      screenshotFullPage,
      maxSnapshotsPerGroup,
    } = opts;

    await this.ensureDir(groupDir);

    const ts = Date.now().toString().padStart(13, '0');
    const uuidShort = crypto.randomUUID().slice(0, 8);
    const baseName = `snapshot_${ts}__${uuidShort}`;
    const htmlPath = path.join(groupDir, `${baseName}.html`);
    const screenshotPath = path.join(groupDir, `${baseName}.png`);
    const metaPath = path.join(groupDir, 'meta.json');

    // Write group-level meta (idempotent-ish)
    const meta = {
      groupId,
      identifier: identifier ?? null,
      threadId: null,
      createdByUserId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      last: { url: url ?? null, action, selector: selector ?? null, text: text ?? null },
      // errorMessage intentionally not persisted long-term; keep meta small
    };
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8').catch(() => undefined);

    // HTML
    if (typeof html === 'string') {
      await fs.writeFile(htmlPath, html, 'utf8').catch(() => undefined);
    }

    // Screenshot (best-effort)
    try {
      await this.page.screenshot({
        path: screenshotPath,
        fullPage: screenshotFullPage ?? true,
      });
    } catch {
      // ignore
    }

    await this.limitSnapshotsInGroup(groupDir, maxSnapshotsPerGroup);

    return {
      groupId,
      htmlPath: typeof html === 'string' ? htmlPath : undefined,
      screenshotPath: screenshotPath,
      metaPath,
    };
  }

  private async resolveDefaultDebugBaseDir(
    context: ISkillExecutionContext,
  ): Promise<string> {
    const scope = String(
      context.parameters?.browserDebugScope ?? 'heart',
    ).toLowerCase();
    if (scope === 'temp') {
      const dir = getMiraBrowserTempBaseDir({
        userId: context.userId,
        runId: context.runId,
        threadId: context.threadId,
      });
      await this.ensureDir(dir);
      return dir;
    }
    const user = await this.usersService.findById(context.userId);
    const identifier = user?.identifier?.trim();
    if (!identifier) return this.fallbackDebugBaseDir;
    const dir = path.join(
      this.workspaceService.getUserDir(identifier),
      'browser_debug',
    );
    await this.ensureDir(dir);
    return dir;
  }

  private async resolveArtifactGroup(opts: {
    context: ISkillExecutionContext;
    identifierParam: unknown;
    debugBaseDirParam: unknown;
    urlHint?: string;
  }): Promise<{
    groupId: string;
    groupDir: string;
    effectiveIdentifier: string;
  }> {
    const defaultDir = await this.resolveDefaultDebugBaseDir(opts.context);
    const baseDir =
      typeof opts.debugBaseDirParam === 'string' && opts.debugBaseDirParam.trim()
        ? opts.debugBaseDirParam.trim()
        : defaultDir;

    const rawId =
      opts.identifierParam != null && String(opts.identifierParam).trim()
        ? String(opts.identifierParam)
        : opts.urlHint || 'unknown';
    const normalizedKey = this.normalizeArtifactGroupKey(rawId);

    const runId = String(opts.context.runId ?? '').trim();
    // Cùng một pipeline (Telegram/agent): một thư mục browser_debug cho mọi bước browser.
    const correlationKey = runId
      ? `run:${runId}`
      : normalizedKey;

    const groupId = this.computeArtifactGroupId(
      opts.context.threadId,
      correlationKey,
    );
    const groupDir = path.join(baseDir, groupId);

    const effectiveIdentifier =
      runId && normalizedKey !== 'unknown'
        ? normalizedKey
        : runId
          ? 'browser_session'
          : normalizedKey;

    return { groupId, groupDir, effectiveIdentifier };
  }

  private async appendSkillDraftStep(
    context: ISkillExecutionContext,
    opts: {
      groupDir: string;
      groupId: string;
      identifier?: string;
      action: string;
      status: 'pass' | 'fail' | 'skip' | 'retry_pass' | 'retry_fail';
      phase?: string;
      currentUrl?: string;
      selector?: string;
      text?: string;
      usedSelector?: string;
      retried?: boolean;
      nextHint?: string;
      error?: string;
      artifacts?: {
        htmlPath?: string;
        screenshotPath?: string;
        metaPath?: string;
      };
    },
  ): Promise<string | undefined> {
    const scope = String(
      context.parameters?.browserDebugScope ?? 'heart',
    ).toLowerCase();
    if (scope === 'temp') {
      return undefined;
    }
    await this.ensureDir(opts.groupDir);
    const draftPath = path.join(opts.groupDir, 'skill_draft.json');

    let draft: any = {
      groupId: opts.groupId,
      identifier: opts.identifier ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      summary: {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        retriedPass: 0,
        retriedFail: 0,
        lastFailedStepNo: null,
        lastFailedSelector: null,
      },
      steps: [],
    };

    try {
      const raw = await fs.readFile(draftPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') draft = parsed;
      if (!Array.isArray(draft.steps)) draft.steps = [];
    } catch {
      // create new draft
    }

    const phase =
      opts.phase ??
      (opts.action === 'navigate'
        ? 'navigation'
        : opts.action === 'cookies_load' || opts.action === 'cookies_save'
          ? 'cookies'
          : opts.action === 'click' || opts.action === 'type'
            ? 'interaction'
            : 'observation');

    const lineParts: string[] = [];
    lineParts.push(opts.action);
    if (opts.selector) lineParts.push(opts.selector);
    lineParts.push('=>');
    lineParts.push(opts.status);
    if (opts.error) lineParts.push(`(${opts.error})`);
    const line = lineParts.join(' ');

    const step = {
      stepNo: draft.steps.length + 1,
      at: new Date().toISOString(),
      phase,
      action: opts.action,
      status: opts.status,
      line,
      url: opts.currentUrl ?? null,
      selector: opts.selector ?? null,
      usedSelector: opts.usedSelector ?? null,
      retried: Boolean(opts.retried),
      text: opts.text ?? null,
      nextHint: opts.nextHint ?? null,
      error: opts.error ?? null,
      artifacts: opts.artifacts ?? null,
    };
    draft.groupId = opts.groupId;
    draft.identifier = opts.identifier ?? draft.identifier ?? null;
    draft.updatedAt = new Date().toISOString();
    draft.lastUrl = opts.currentUrl ?? draft.lastUrl ?? null;
    draft.steps.push(step);

    // Rebuild summary (small list, simpler and consistent).
    const summary = {
      total: draft.steps.length,
      passed: 0,
      failed: 0,
      skipped: 0,
      retriedPass: 0,
      retriedFail: 0,
      lastFailedStepNo: null as number | null,
      lastFailedSelector: null as string | null,
    };
    for (const s of draft.steps) {
      if (s.status === 'pass') summary.passed += 1;
      else if (s.status === 'fail') summary.failed += 1;
      else if (s.status === 'skip') summary.skipped += 1;
      else if (s.status === 'retry_pass') summary.retriedPass += 1;
      else if (s.status === 'retry_fail') summary.retriedFail += 1;

      if (s.status === 'fail' || s.status === 'retry_fail') {
        summary.lastFailedStepNo = s.stepNo;
        summary.lastFailedSelector = s.selector || s.usedSelector || null;
      }
    }
    draft.summary = summary;

    await fs.writeFile(draftPath, JSON.stringify(draft, null, 2), 'utf8');
    return draftPath;
  }

  private buildHeuristicCandidateSelectors(selector: string): string[] {
    const s = selector.trim();
    const candidates = new Set<string>();
    if (!s) return [];
    candidates.add(s);

    // aria-label / placeholder / data-testid
    const aria = s.match(/aria-label\s*=\s*['"]([^'"]+)['"]/i);
    if (aria?.[1]) {
      const v = aria[1];
      candidates.add(`[aria-label="${v}"]`);
      candidates.add(`button[aria-label="${v}"]`);
      candidates.add(`[role="button"][aria-label="${v}"]`);
      candidates.add(`[role="link"][aria-label="${v}"]`);
    }
    const placeholder = s.match(/placeholder\s*=\s*['"]([^'"]+)['"]/i);
    if (placeholder?.[1]) {
      const v = placeholder[1];
      candidates.add(`[placeholder="${v}"]`);
      candidates.add(`input[placeholder="${v}"]`);
      candidates.add(`textarea[placeholder="${v}"]`);
    }
    const dataTestId = s.match(/data-testid\s*=\s*['"]([^'"]+)['"]/i);
    if (dataTestId?.[1]) {
      const v = dataTestId[1];
      candidates.add(`[data-testid="${v}"]`);
      candidates.add(`[data-test-id="${v}"]`);
    }

    // #id
    const idMatch = s.match(/^#([a-zA-Z0-9_-]+)$/);
    if (idMatch?.[1]) {
      const id = idMatch[1];
      candidates.add(`#${id}`);
      candidates.add(`[id="${id}"]`);
    }

    // .class (only if it's a simple class selector)
    const classMatch = s.match(/^\.(\w[\w-]*)$/);
    if (classMatch?.[1]) {
      const className = classMatch[1];
      candidates.add(`.${className}`);
      candidates.add(`[class~="${className}"]`);
    }

    return Array.from(candidates);
  }

  private buildTextHintCandidateSelectors(
    action: 'click' | 'type',
    hints: string[],
  ): string[] {
    const clean = hints
      .map((h) => String(h || '').trim())
      .filter((h) => h.length >= 2)
      .slice(0, 8);
    const out: string[] = [];
    for (const h of clean) {
      const escaped = h.replace(/"/g, '\\"');
      const longOrPhrase = h.includes(' ') || h.length > 18;
      if (action === 'click') {
        out.push(
          `text=${h}`,
          `:text("${escaped}")`,
          `[role="button"]:has-text("${escaped}")`,
        );
        // Bare div/span :has-text matches nested feed copy — skip for long phrases.
        if (!longOrPhrase) {
          out.push(
            `div:has-text("${escaped}")`,
            `span:has-text("${escaped}")`,
          );
        }
      } else {
        out.push(
          `[role="textbox"]:has-text("${escaped}")`,
          `div[contenteditable="true"]:has-text("${escaped}")`,
          `textarea[placeholder*="${escaped}"]`,
          `input[placeholder*="${escaped}"]`,
          `:text("${escaped}")`,
        );
      }
    }
    return Array.from(new Set(out));
  }

  /** Fallback when JSON missing, invalid, or domain has no non-empty list. */
  private builtInFacebookPresetSelectors(action: 'click' | 'type'): string[] {
    if (action === 'click') {
      return [
        '[role="button"][aria-label*="Đăng cập nhật trạng thái"]',
        '[role="button"][aria-label*="Update status"]',
        '[role="button"][aria-label*="Write something"]',
        '[aria-label*="Bạn đang nghĩ gì"]',
        "[aria-label*=\"What's on your mind\"]",
        '[aria-label*="Tạo bài viết"]',
        '[aria-label*="Create post"]',
        '[role="button"][aria-label*="Bài viết"]',
        '[role="button"][aria-label*="Post"]',
        // Composer "Next" / "Tiếp" — FB dùng div[role=button] nhiều hơn <button>
        'div[role="button"]:has-text("Tiếp")',
        'div[role="button"]:has-text("Next")',
        'button:has-text("Tiếp")',
        'button:has-text("Next")',
        '[role="button"][aria-label*="Tiếp"]',
        '[role="button"][aria-label*="Next"]',
        // Publish
        'div[role="button"]:has-text("Đăng")',
        'div[role="button"]:has-text("Post")',
        'span:has-text("Đăng")',
        'span:has-text("Post")',
        'button:has-text("Đăng")',
        'button:has-text("Post")',
        '[role="button"][aria-label*="Đăng"]',
        '[role="button"][aria-label*="Post"]',
      ];
    }
    return [
      'div[role="textbox"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      '[aria-label*="Bạn đang nghĩ gì"][role="textbox"]',
      "[aria-label*=\"What's on your mind\"][role=\"textbox\"]",
    ];
  }

  /** Safe basename for `<domain>.json` (one preset file per domain, no duplicate keys). */
  private isValidPresetDomainBasename(b: string): boolean {
    return /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(String(b ?? '').trim());
  }

  /**
   * Resolve which `<domain>.json` applies to this host without readdir: try suffixes from
   * most specific (e.g. m.facebook.com) to broader (facebook.com) until a file exists.
   * One file per domain name — no duplicate keys; add a new site = new filename.
   */
  /**
   * User dir `$BRAIN_DIR/<id>/browser_dom_presets/<domain>.json` wins over `_shared` (hot-swap BRAIN_DIR root).
   */
  private async resolvePresetFileKeyForHost(
    host: string,
    userIdentifier?: string | null,
  ): Promise<string | null> {
    const h = (host || '').toLowerCase().replace(/^www\./, '').trim();
    if (!h) return null;
    const labels = h.split('.').filter(Boolean);
    if (labels.length < 2) return null;
    const sharedDir = this.workspaceService.getSharedBrowserDomPresetsDir();
    const userDir = userIdentifier
      ? this.workspaceService.getUserBrowserDomPresetsDir(userIdentifier)
      : null;
    for (let start = 0; start < labels.length - 1; start++) {
      const candidate = labels.slice(start).join('.');
      if (!this.isValidPresetDomainBasename(candidate)) continue;
      if (userDir) {
        const userPath = path.join(userDir, `${candidate}.json`);
        const ust = await fs.stat(userPath).catch(() => null);
        if (ust?.isFile()) return candidate;
      }
      const sharedPath = path.join(sharedDir, `${candidate}.json`);
      const sst = await fs.stat(sharedPath).catch(() => null);
      if (sst?.isFile()) return candidate;
    }
    return null;
  }

  private async resolveBrowserDomPresetFilePath(
    baseKey: string,
    userIdentifier?: string | null,
  ): Promise<string | null> {
    if (!this.isValidPresetDomainBasename(baseKey)) return null;
    if (userIdentifier) {
      const userPath = path.join(
        this.workspaceService.getUserBrowserDomPresetsDir(userIdentifier),
        `${baseKey}.json`,
      );
      const ust = await fs.stat(userPath).catch(() => null);
      if (ust?.isFile()) return userPath;
    }
    const sharedPath = path.join(
      this.workspaceService.getSharedBrowserDomPresetsDir(),
      `${baseKey}.json`,
    );
    const sst = await fs.stat(sharedPath).catch(() => null);
    return sst?.isFile() ? sharedPath : null;
  }

  private parseBrowserDomPresetDomainEntry(
    obj: Record<string, unknown>,
  ): BrowserDomPresetDomainEntry {
    const pubRaw = obj.publishVerification;
    let publishVerification: BrowserDomPublishVerificationConfig | undefined;
    if (pubRaw && typeof pubRaw === 'object') {
      const p = pubRaw as Record<string, unknown>;
      publishVerification = {
        enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined,
        bodyTextContains: Array.isArray(p.bodyTextContains)
          ? (p.bodyTextContains as unknown[]).map(String)
          : undefined,
        liveRegionTextContains: Array.isArray(p.liveRegionTextContains)
          ? (p.liveRegionTextContains as unknown[]).map(String)
          : undefined,
        assumeSuccessWhenComposerClosed:
          typeof p.assumeSuccessWhenComposerClosed === 'boolean'
            ? p.assumeSuccessWhenComposerClosed
            : undefined,
        composerDialogSelectors: Array.isArray(p.composerDialogSelectors)
          ? (p.composerDialogSelectors as unknown[]).map(String)
          : undefined,
        liveRegionSelectors: Array.isArray(p.liveRegionSelectors)
          ? (p.liveRegionSelectors as unknown[]).map(String)
          : undefined,
        pollDelaysMs: Array.isArray(p.pollDelaysMs)
          ? (p.pollDelaysMs as unknown[])
              .map((n) => Number(n))
              .filter((n) => Number.isFinite(n) && n >= 0)
          : undefined,
        maxPollAttempts:
          typeof p.maxPollAttempts === 'number' && p.maxPollAttempts >= 1
            ? Math.floor(p.maxPollAttempts)
            : undefined,
      };
    }
    const loginRaw = obj.loginSuccess;
    let loginSuccess: BrowserDomLoginSuccessConfig | undefined;
    if (loginRaw && typeof loginRaw === 'object') {
      const l = loginRaw as Record<string, unknown>;
      loginSuccess = {
        sessionCookiePattern:
          typeof l.sessionCookiePattern === 'string'
            ? l.sessionCookiePattern
            : undefined,
        domSelectors: Array.isArray(l.domSelectors)
          ? (l.domSelectors as unknown[]).map(String)
          : undefined,
      };
    }
    const rgRaw = obj.retryGuards;
    let retryGuards: BrowserDomRetryGuardsConfig | undefined;
    if (rgRaw && typeof rgRaw === 'object') {
      const r = rgRaw as Record<string, unknown>;
      retryGuards = {
        composerOpenSubstrings: Array.isArray(r.composerOpenSubstrings)
          ? (r.composerOpenSubstrings as unknown[]).map(String)
          : undefined,
        composerStepDenyCandidatePatterns: Array.isArray(
          r.composerStepDenyCandidatePatterns,
        )
          ? (r.composerStepDenyCandidatePatterns as unknown[]).map(String)
          : undefined,
        publishIntentSelectorPatterns: Array.isArray(
          r.publishIntentSelectorPatterns,
        )
          ? (r.publishIntentSelectorPatterns as unknown[]).map(String)
          : undefined,
      };
    }
    return {
      version: typeof obj.version === 'number' ? obj.version : undefined,
      click: Array.isArray(obj.click) ? (obj.click as string[]) : undefined,
      type: Array.isArray(obj.type) ? (obj.type as string[]) : undefined,
      scrollAssistBeforeRetry:
        typeof obj.scrollAssistBeforeRetry === 'boolean'
          ? obj.scrollAssistBeforeRetry
          : undefined,
      publishVerification,
      loginSuccess,
      retryGuards,
    };
  }

  /** Reads `$BRAIN_DIR/<user>/browser_dom_presets/<baseKey>.json` if present, else `_shared`. */
  private async loadBrowserDomPresetForDomainKey(
    baseKey: string,
    userIdentifier?: string | null,
  ): Promise<BrowserDomPresetDomainEntry | null> {
    const filePath = await this.resolveBrowserDomPresetFilePath(
      baseKey,
      userIdentifier,
    );
    if (!filePath) return null;
    const st = await fs.stat(filePath).catch(() => null);
    if (!st?.isFile()) return null;
    const cached = this.domPresetFileCache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs) {
      return cached.entry;
    }
    let text = '';
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      this.logger.debug(`browser_dom_presets read failed: ${e}`);
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      this.logger.warn(`browser_dom_presets invalid JSON at ${filePath}: ${e}`);
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const entry = this.parseBrowserDomPresetDomainEntry(
      parsed as Record<string, unknown>,
    );
    this.domPresetFileCache.set(filePath, { mtimeMs: st.mtimeMs, entry });
    return entry;
  }

  private async loadBrowserDomPresetForPage(
    context: ISkillExecutionContext,
    urlLike: string | undefined,
  ): Promise<BrowserDomPresetDomainEntry | null> {
    const userIdentifier = await this.resolveCookieIdentifier(
      context,
      context.parameters.identifier,
    );
    const host = this.getDomainKeyFromUrlLike(urlLike || '') || '';
    const key = await this.resolvePresetFileKeyForHost(host, userIdentifier);
    if (!key) return null;
    return this.loadBrowserDomPresetForDomainKey(key, userIdentifier);
  }

  /**
   * Hostname-keyed Playwright selector lists for click/type auto-retry.
   * Loads only the matching `browser_dom_presets/<domain>.json`; falls back to built-in Facebook lists.
   */
  private async getSitePresetSelectors(
    action: 'click' | 'type',
    urlLike: string | undefined,
    userIdentifier: string,
  ): Promise<string[]> {
    try {
      const host = this.getDomainKeyFromUrlLike(urlLike || '') || '';
      const matchKey = await this.resolvePresetFileKeyForHost(host, userIdentifier);
      if (matchKey) {
        const entry = await this.loadBrowserDomPresetForDomainKey(
          matchKey,
          userIdentifier,
        );
        const list = entry?.[action];
        if (Array.isArray(list) && list.length > 0) {
          return list
            .map((s) => String(s).trim())
            .filter((s) => s.length > 0);
        }
      }
    } catch (e) {
      this.logger.debug(`getSitePresetSelectors: ${e}`);
    }
    if (this.isFacebookUrl(urlLike)) {
      return this.builtInFacebookPresetSelectors(action);
    }
    return [];
  }

  private async shouldScrollAssistBeforeRetry(
    urlLike: string | undefined,
    userIdentifier: string,
  ): Promise<boolean> {
    try {
      const host = this.getDomainKeyFromUrlLike(urlLike || '') || '';
      const matchKey = await this.resolvePresetFileKeyForHost(host, userIdentifier);
      if (!matchKey) return false;
      const entry = await this.loadBrowserDomPresetForDomainKey(
        matchKey,
        userIdentifier,
      );
      return entry?.scrollAssistBeforeRetry === true;
    } catch {
      // ignore
    }
    return false;
  }

  private isFacebookUrl(urlLike: string | undefined): boolean {
    if (!urlLike) return false;
    const d = this.getDomainKeyFromUrlLike(urlLike) || '';
    return d === 'facebook.com' || d.endsWith('.facebook.com');
  }

  private isComposerOpenIntent(
    selectorStr: string,
    hints: string[],
    preset?: BrowserDomPresetDomainEntry | null,
  ): boolean {
    const subs = preset?.retryGuards?.composerOpenSubstrings;
    const phrases =
      subs && subs.length > 0
        ? subs
        : ['nghĩ gì', "what's on your mind"];
    const s = selectorStr.toLowerCase();
    const joinedHints = hints.join(' ').toLowerCase();
    return phrases.some(
      (p) =>
        s.includes(p.toLowerCase()) || joinedHints.includes(p.toLowerCase()),
    );
  }

  /** Generic English/VN-ish heuristics when JSON has no `publishIntentSelectorPatterns`. */
  private isPublishIntentBuiltin(selectorStr: string): boolean {
    const s = String(selectorStr ?? '');
    const lower = s.toLowerCase();
    if (lower.includes('đăng nhập') || lower.includes('log in')) return false;
    return (
      /has-text\s*\(\s*['"]đăng['"]/i.test(s) ||
      /has-text\s*\(\s*['"]post['"]/i.test(s) ||
      /aria-label\s*=\s*['"]đăng['"]/i.test(s) ||
      /aria-label\s*=\s*['"]post['"]/i.test(s) ||
      /aria-label\s*\*=\s*['"][^'"]*post[^'"]*['"]/i.test(s) ||
      /aria-label\s*\*=\s*['"][^'"]*đăng[^'"]*['"]/i.test(s) ||
      /:text\s*\(\s*['"]đăng['"]/i.test(s) ||
      /:text\s*\(\s*['"]post['"]/i.test(s) ||
      /text\s*=\s*['"]đăng['"]/i.test(s) ||
      /text\s*=\s*['"]post['"]/i.test(s)
    );
  }

  private isPublishIntentSelector(
    selectorStr: string,
    preset?: BrowserDomPresetDomainEntry | null,
  ): boolean {
    const patterns = preset?.retryGuards?.publishIntentSelectorPatterns;
    if (patterns?.length) {
      return patterns.some((p) => {
        try {
          return new RegExp(p, 'i').test(selectorStr);
        } catch {
          return false;
        }
      });
    }
    return this.isPublishIntentBuiltin(selectorStr);
  }

  /** Retry guard: avoid picking “Đăng” while the step intent was “open composer”. */
  private isComposerStepDenyCandidate(
    candidate: string,
    preset?: BrowserDomPresetDomainEntry | null,
  ): boolean {
    const patterns = preset?.retryGuards?.composerStepDenyCandidatePatterns;
    if (patterns?.length) {
      return patterns.some((p) => {
        try {
          return new RegExp(p, 'i').test(candidate);
        } catch {
          return false;
        }
      });
    }
    return /(^text=đăng$|:text\("đăng"\)|\bđăng\b)/i.test(candidate);
  }

  private mergePublishVerificationConfig(
    fromFile?: BrowserDomPublishVerificationConfig | null,
  ): BrowserDomPublishVerificationConfig {
    const m = MINIMAL_PUBLISH_VERIFICATION_FALLBACK;
    const f = fromFile ?? {};
    return {
      enabled: f.enabled !== false,
      bodyTextContains:
        f.bodyTextContains && f.bodyTextContains.length > 0
          ? f.bodyTextContains
          : m.bodyTextContains ?? [],
      liveRegionTextContains:
        f.liveRegionTextContains && f.liveRegionTextContains.length > 0
          ? f.liveRegionTextContains
          : m.liveRegionTextContains ?? [],
      assumeSuccessWhenComposerClosed:
        f.assumeSuccessWhenComposerClosed !== false,
      composerDialogSelectors:
        f.composerDialogSelectors && f.composerDialogSelectors.length > 0
          ? f.composerDialogSelectors
          : m.composerDialogSelectors,
      liveRegionSelectors:
        f.liveRegionSelectors && f.liveRegionSelectors.length > 0
          ? f.liveRegionSelectors
          : m.liveRegionSelectors,
      pollDelaysMs:
        f.pollDelaysMs && f.pollDelaysMs.length > 0
          ? f.pollDelaysMs
          : m.pollDelaysMs,
      maxPollAttempts: f.maxPollAttempts,
    };
  }

  /**
   * Post-click checks driven by `browser_dom_presets/<domain>.json` → `publishVerification`.
   * Edit JSON under `$BRAIN_DIR/` (or user override) without redeploying.
   */
  private async verifyPublishSuccess(
    cfg?: BrowserDomPublishVerificationConfig | null,
  ): Promise<{ ok: boolean; reason: string }> {
    if (cfg?.enabled === false) {
      return { ok: true, reason: 'publish-verification-disabled-by-config' };
    }
    const effective = this.mergePublishVerificationConfig(cfg);
    if (effective.enabled === false) {
      return { ok: true, reason: 'publish-verification-disabled-by-config' };
    }
    const delays = effective.pollDelaysMs?.length
      ? effective.pollDelaysMs
      : MINIMAL_PUBLISH_VERIFICATION_FALLBACK.pollDelaysMs!;
    const maxAttempts =
      typeof effective.maxPollAttempts === 'number' && effective.maxPollAttempts >= 1
        ? Math.min(20, Math.floor(effective.maxPollAttempts))
        : delays.length;

    const readOnce = async () =>
      this.page.evaluate((config: BrowserDomPublishVerificationConfig) => {
        const body = (document.body?.innerText || '').toLowerCase();
        const bodyPhrases = (config.bodyTextContains || []).map((p) =>
          p.toLowerCase(),
        );
        const positiveBody = bodyPhrases.some((p) => p.length && body.includes(p));
        const liveSelectors = (config.liveRegionSelectors || []).join(',');
        const livePhrases = (config.liveRegionTextContains || []).map((p) =>
          p.toLowerCase(),
        );
        let liveText = '';
        if (liveSelectors.length) {
          try {
            liveText = Array.from(
              document.querySelectorAll(liveSelectors),
            )
              .map((el) => (el.textContent || '').toLowerCase())
              .join(' ');
          } catch {
            /* ignore */
          }
        }
        const livePositive =
          livePhrases.length > 0 &&
          livePhrases.some((p) => p.length && liveText.includes(p));
        const composerSels = config.composerDialogSelectors || [];
        let dialogOpen = false;
        for (const sel of composerSels) {
          try {
            if (sel && document.querySelector(sel)) {
              dialogOpen = true;
              break;
            }
          } catch {
            /* ignore */
          }
        }
        return {
          positive: positiveBody || livePositive,
          dialogOpen,
        };
      }, effective);

    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const waitMs = delays[Math.min(attempt, delays.length - 1)] ?? 1500;
        await this.page.waitForTimeout(waitMs);
        const result = await readOnce();
        if (result.positive) return { ok: true, reason: 'publish-indicator-found' };
        if (
          !result.dialogOpen &&
          effective.assumeSuccessWhenComposerClosed !== false
        ) {
          return { ok: true, reason: 'composer-closed-assumed-published' };
        }
      }
      const last = await readOnce();
      if (
        !last.dialogOpen &&
        effective.assumeSuccessWhenComposerClosed !== false
      ) {
        return { ok: true, reason: 'composer-closed-assumed-published' };
      }
      return { ok: false, reason: 'no-publish-indicator' };
    } catch {
      return { ok: false, reason: 'publish-verification-error' };
    }
  }

  private async isLocatorEditable(loc: any): Promise<boolean> {
    try {
      return await loc.evaluate((el: HTMLElement) => {
        const tag = (el.tagName || '').toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        const editable = (el.getAttribute('contenteditable') || '').toLowerCase();
        if (tag === 'input') {
          const t = (el as HTMLInputElement).type?.toLowerCase() ?? '';
          if (t === 'file') return false;
        }
        if (tag === 'input' || tag === 'textarea') return true;
        if (role === 'textbox') return true;
        if (editable === 'true' || editable === '') return true;
        return false;
      });
    } catch {
      return false;
    }
  }

  /** Selector string targets a file input (Facebook hides these; use setInputFiles + attached). */
  private isFileInputSelectorString(selectorStr: string): boolean {
    const s = selectorStr.trim().replace(/\s/g, '');
    return /input\[type=['"]?file['"]?\]/i.test(s);
  }

  /** Absolute path to an existing local file (for upload steps). */
  private looksLikeExistingLocalFilePath(p: string): boolean {
    const t = p.trim();
    if (t.length < 2) return false;
    if (!t.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(t)) return false;
    try {
      return existsSync(t) && statSync(t).isFile();
    } catch {
      return false;
    }
  }

  private async isLocatorFileInput(loc: any): Promise<boolean> {
    try {
      return await loc.evaluate((el: HTMLElement) => {
        return el instanceof HTMLInputElement && el.type === 'file';
      });
    } catch {
      return false;
    }
  }

  private candidateSeemsPresentInHtml(
    candidateSelector: string,
    html: string,
  ): boolean {
    const cand = candidateSelector;
    const aria = cand.match(/aria-label\s*=\s*['"]([^'"]+)['"]/i);
    if (aria?.[1]) return html.includes(`aria-label="${aria[1]}"`);

    const placeholder = cand.match(/placeholder\s*=\s*['"]([^'"]+)['"]/i);
    if (placeholder?.[1]) return html.includes(`placeholder="${placeholder[1]}"`);

    const dataTestId = cand.match(/data-testid\s*=\s*['"]([^'"]+)['"]/i);
    if (dataTestId?.[1]) return html.includes(`data-testid="${dataTestId[1]}"`);

    const dataTestIdAlt = cand.match(/data-test-id\s*=\s*['"]([^'"]+)['"]/i);
    if (dataTestIdAlt?.[1])
      return html.includes(`data-test-id="${dataTestIdAlt[1]}"`);

    const idMatch = cand.match(/^#([a-zA-Z0-9_-]+)$/);
    if (idMatch?.[1]) return html.includes(`id="${idMatch[1]}"`);

    const classMatch = cand.match(/^\.(\w[\w-]*)$/);
    if (classMatch?.[1]) {
      const c = classMatch[1];
      return html.includes(`class="${c}`) || html.includes(` ${c} `);
    }

    // Fallback: không có hint rõ thì cho thử
    return true;
  }

  // ─── Cookies: Load/Save from $BRAIN_DIR/<identifier>/cookies/<domain>.json ───

  private getDomainKeyFromHostname(hostname: string): string {
    const h = String(hostname ?? '')
      .trim()
      .toLowerCase()
      .replace(/^www\./i, '');
    return h || 'unknown';
  }

  private async resolveCookieIdentifier(
    context: ISkillExecutionContext,
    identifierParam: unknown,
  ): Promise<string> {
    const user = await this.usersService.findById(context.userId);
    const dbIdentifier = user?.identifier?.trim();
    if (dbIdentifier) return dbIdentifier;
    if (typeof identifierParam === 'string' && identifierParam.trim()) {
      return identifierParam.trim();
    }
    return 'unknown';
  }

  private async resolveCookieFilePath(opts: {
    context: ISkillExecutionContext;
    identifierParam: unknown;
    domainParam: unknown;
    cookieFilePathParam: unknown;
    urlParam?: unknown;
  }): Promise<{ filePath?: string; domainKey?: string }> {
    const cookieFilePathStr =
      typeof opts.cookieFilePathParam === 'string' &&
      opts.cookieFilePathParam.trim()
        ? opts.cookieFilePathParam.trim()
        : undefined;
    if (cookieFilePathStr) return { filePath: cookieFilePathStr };

    let domainKey: string | undefined =
      typeof opts.domainParam === 'string' && opts.domainParam.trim()
        ? this.getDomainKeyFromHostname(opts.domainParam.trim())
        : undefined;

    const urlStr =
      typeof opts.urlParam === 'string' && opts.urlParam.trim()
        ? opts.urlParam.trim()
        : undefined;
    if (!domainKey && urlStr) {
      try {
        const u = new URL(urlStr);
        domainKey = this.getDomainKeyFromHostname(u.hostname);
      } catch {
        // ignore
      }
    }

    if (!domainKey) return {};
    const identifier = await this.resolveCookieIdentifier(
      opts.context,
      opts.identifierParam,
    );
    const filePath = this.workspaceService.getUserCookieFilePath(
      identifier,
      domainKey,
    );
    return { filePath, domainKey };
  }

  private normalizeCookieForPlaywright(rawCookie: any): any {
    const c = { ...(rawCookie ?? {}) };
    if (c.expires == null && c.expiry != null) c.expires = c.expiry;
    if (typeof c.expires === 'string') {
      const n = Number(c.expires);
      if (Number.isFinite(n)) c.expires = n;
    }
    if (typeof c.expires === 'number' && Number.isFinite(c.expires)) {
      c.expires = Math.floor(c.expires);
    }
    return c;
  }

  private async cookiesLoadFromFile(
    context: ISkillExecutionContext,
    identifierParam: unknown,
    domainParam: unknown,
    cookieFilePathParam: unknown,
    urlParam?: unknown,
  ): Promise<{
    loaded: boolean;
    filePath?: string;
    domainKey?: string;
    userIdentifier?: string;
    error?: string;
  }> {
    await this.ensureBrowser();

    const identifier = await this.resolveCookieIdentifier(
      context,
      identifierParam,
    );
    const resolved = await this.resolveCookieFilePath({
      context,
      identifierParam,
      domainParam,
      cookieFilePathParam,
      urlParam,
    });
    if (!resolved.filePath) {
      return {
        loaded: false,
        userIdentifier: identifier,
        error: 'Could not resolve cookie file path',
      };
    }

    try {
      const raw = await fs.readFile(resolved.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const cookiesArr = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.cookies)
          ? parsed.cookies
          : [];

      const normalizedCookies = cookiesArr
        .map((c: any) => this.normalizeCookieForPlaywright(c))
        .filter((c: any) => c && c.name && c.value && c.domain);

      if (!normalizedCookies.length) {
        return {
          loaded: false,
          filePath: resolved.filePath,
          domainKey: resolved.domainKey,
          userIdentifier: identifier,
          error: 'No cookies found in file',
        };
      }

      await this.context.addCookies(normalizedCookies);
      return {
        loaded: true,
        filePath: resolved.filePath,
        domainKey: resolved.domainKey,
        userIdentifier: identifier,
      };
    } catch (err: any) {
      // Fallback for legacy cookie file location:
      //   $BRAIN_DIR/<identifier>/workspace/facebook_cookies.json
      const legacyCandidates: string[] = [];
      if (resolved.domainKey) {
        const workspaceDir =
          this.workspaceService.getUserWorkspaceDir(identifier);
        // Domain-specific legacy: <domain>_cookies.json (best-effort)
        legacyCandidates.push(
          path.join(workspaceDir, `${resolved.domainKey}_cookies.json`),
          path.join(
            workspaceDir,
            `${resolved.domainKey.replace(/\./g, '_')}_cookies.json`,
          ),
        );
        // Facebook-specific: facebook_cookies.json (as used by your old setup)
        if (
          resolved.domainKey === 'facebook.com' ||
          resolved.domainKey.includes('facebook')
        ) {
          legacyCandidates.push(path.join(workspaceDir, 'facebook_cookies.json'));
        }
      }

      for (const legacyPath of legacyCandidates) {
        try {
          const rawLegacy = await fs.readFile(legacyPath, 'utf8');
          const parsedLegacy = JSON.parse(rawLegacy);
          const cookiesArr = Array.isArray(parsedLegacy)
            ? parsedLegacy
            : Array.isArray(parsedLegacy?.cookies)
              ? parsedLegacy.cookies
              : [];

          const normalizedCookies = cookiesArr
            .map((c: any) => this.normalizeCookieForPlaywright(c))
            .filter((c: any) => c && c.name && c.value && c.domain);

          if (!normalizedCookies.length) continue;

          await this.context.addCookies(normalizedCookies);
          return {
            loaded: true,
            filePath: legacyPath,
            domainKey: resolved.domainKey,
            userIdentifier: identifier,
          };
        } catch {
          // try next
        }
      }

      return {
        loaded: false,
        filePath: resolved.filePath,
        domainKey: resolved.domainKey,
        userIdentifier: identifier,
        error: err?.message ?? String(err),
      };
    }
  }

  private async cookiesSaveToFile(
    context: ISkillExecutionContext,
    identifierParam: unknown,
    domainParam: unknown,
    urlParam: unknown,
  ): Promise<{ saved: boolean; filePath?: string; domainKey?: string; error?: string }> {
    await this.ensureBrowser();

    // Determine domain by explicit param first, then url.
    let domainKey: string | undefined =
      typeof domainParam === 'string' && domainParam.trim()
        ? this.getDomainKeyFromHostname(domainParam.trim())
        : undefined;

    const urlStr =
      typeof urlParam === 'string' && urlParam.trim() ? urlParam.trim() : '';
    if (!domainKey && urlStr) {
      try {
        const u = new URL(urlStr);
        domainKey = this.getDomainKeyFromHostname(u.hostname);
      } catch {
        // ignore
      }
    }

    if (!domainKey) return { saved: false, error: 'Could not resolve cookie domain' };

    const identifier = await this.resolveCookieIdentifier(
      context,
      identifierParam,
    );
    const filePath = this.workspaceService.getUserCookieFilePath(
      identifier,
      domainKey,
    );
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    try {
      const cookies = await this.context.cookies();
      const normalizedCookies = cookies.map((c: any) => ({
        ...c,
        // Save in both formats (your sample uses "expiry")
        expiry: c.expires,
      }));
      const user = await this.usersService.findById(context.userId);
      const payload = {
        email: user?.email ?? undefined,
        identifier,
        domain: domainKey,
        savedAt: new Date().toISOString(),
        cookies: normalizedCookies,
      };
      await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
      return { saved: true, filePath, domainKey };
    } catch (err: any) {
      return {
        saved: false,
        filePath,
        domainKey,
        error: err?.message ?? String(err),
      };
    }
  }

  private getDomainKeyFromUrlLike(value: unknown): string | null {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return null;
    try {
      const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      const u = new URL(normalized);
      return this.getDomainKeyFromHostname(u.hostname);
    } catch {
      return this.getDomainKeyFromHostname(raw);
    }
  }

  /**
   * Optional `loginSuccess` in `browser_dom_presets/<domain>.json` (session cookie regex + DOM selectors).
   * Editable when `$BRAIN_DIR` is mounted elsewhere — no redeploy.
   */
  private async isLikelyLoginSuccessForDomain(
    domainKey: string,
    context: ISkillExecutionContext,
    identifierParam: unknown,
  ): Promise<boolean> {
    try {
      const currentUrl = String(this.page?.url?.() ?? '').toLowerCase();
      if (
        currentUrl.includes('login') ||
        currentUrl.includes('checkpoint') ||
        currentUrl.includes('recover') ||
        currentUrl.includes('signin') ||
        currentUrl.includes('oauth') ||
        currentUrl.includes('auth')
      ) {
        return false;
      }

      const hasAnyClientCookie = await this.page.evaluate(() => {
        const cookieStr = document.cookie || '';
        return cookieStr.trim().length > 0;
      });

      const hasPasswordInput = await this.page.evaluate(() => {
        return Boolean(document.querySelector('input[type="password"]'));
      });

      if (hasPasswordInput) return false;

      const userIdentifier = await this.resolveCookieIdentifier(
        context,
        identifierParam,
      );
      const matchKey = await this.resolvePresetFileKeyForHost(
        domainKey,
        userIdentifier,
      );
      const preset = matchKey
        ? await this.loadBrowserDomPresetForDomainKey(matchKey, userIdentifier)
        : null;
      const login = preset?.loginSuccess;

      if (login?.sessionCookiePattern) {
        const ok = await this.page.evaluate((pattern: string) => {
          try {
            return new RegExp(pattern).test(document.cookie || '');
          } catch {
            return false;
          }
        }, login.sessionCookiePattern);
        if (ok) return true;
      }

      if (login?.domSelectors?.length) {
        const ok = await this.page.evaluate((sels: string[]) => {
          return sels.some((sel) => {
            try {
              return Boolean(document.querySelector(sel));
            } catch {
              return false;
            }
          });
        }, login.domSelectors);
        if (ok) return true;
      }

      return Boolean(hasAnyClientCookie);
    } catch {
      return false;
    }
  }

  async execute(context: ISkillExecutionContext): Promise<ISkillResult> {
    const start = Date.now();
    const {
      action,
      url,
      selector,
      textHints,
      text,
      script,
      identifier,
      debugBaseDir,
      saveOnError = true,
      autoRetryOnFailure,
      maxSnapshotsPerGroup,
      fullPage,
      waitMs = 1000,
      selectorTimeoutMs: selectorTimeoutMsParam,
      domain,
      cookieFilePath,
      loadCookiesForUrl,
      saveCookiesAfterNavigation,
      autoSaveCookiesOnLoginSuccess,
      skipPublishVerification,
      useMobileContext,
      mobileViewportWidth,
      mobileViewportHeight,
      mobileUserAgent,
    } = context.parameters;

    const selectorTimeoutMs = (() => {
      const n = Number(selectorTimeoutMsParam ?? 12000);
      if (!Number.isFinite(n)) return 12000;
      return Math.min(120_000, Math.max(1000, Math.floor(n)));
    })();

    // status: read-only, không cần lock
    if (String(action) === 'status') {
      return {
        success: true,
        data: {
          browserActive: !!this.browser,
          currentUrl: this.page ? await this.page.url() : null,
        },
        metadata: { durationMs: Date.now() - start },
      };
    }

    // Serialize tất cả browser ops — tránh 2 task tranh cùng 1 page/context
    const lockAcquired = await this.acquireBrowserLock();
    if (!lockAcquired) {
      return {
        success: false,
        error:
          'Browser đang bận (chờ lock 90s vẫn chưa được). ' +
          'Tác vụ browser khác đang chạy — hãy thử lại sau vài giây.',
        metadata: { durationMs: Date.now() - start },
      };
    }

    try {
      switch (action) {
        case 'status':
          // Đã xử lý ở trên, không bao giờ tới đây
          return {
            success: true,
            data: { browserActive: !!this.browser, currentUrl: null },
            metadata: { durationMs: Date.now() - start },
          };

        case 'navigate': {
          const mobileRequested =
            useMobileContext === true ||
            (typeof useMobileContext === 'string' &&
              useMobileContext.toLowerCase() === 'true');
          const vw = Number(mobileViewportWidth ?? 390);
          const vh = Number(mobileViewportHeight ?? 844);
          const safeVw = Number.isFinite(vw)
            ? Math.min(1400, Math.max(280, Math.floor(vw)))
            : 390;
          const safeVh = Number.isFinite(vh)
            ? Math.min(2000, Math.max(500, Math.floor(vh)))
            : 844;
          const ua =
            typeof mobileUserAgent === 'string' && mobileUserAgent.trim().length > 0
              ? mobileUserAgent.trim()
              : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
          if (mobileRequested) {
            await this.ensureBrowser({
              forceRecreate: true,
              contextOptions: {
                userAgent: ua,
                viewport: { width: safeVw, height: safeVh },
                isMobile: true,
                hasTouch: true,
                deviceScaleFactor: 2,
              },
            });
          } else {
            await this.ensureBrowser();
          }
          try {
            const group = await this.resolveArtifactGroup({
              context,
              identifierParam: identifier,
              debugBaseDirParam: debugBaseDir,
              urlHint: typeof url === 'string' ? url : undefined,
            });
            // Schema default: loadCookiesForUrl=true; treat undefined as true.
            const shouldLoadCookies =
              loadCookiesForUrl !== false &&
              !(
                typeof loadCookiesForUrl === 'string' &&
                loadCookiesForUrl.toLowerCase() === 'false'
              );
            let cookieLoadInfo:
              | Awaited<ReturnType<BrowserSkill['cookiesLoadFromFile']>>
              | undefined;
            if (shouldLoadCookies) {
              cookieLoadInfo = await this.cookiesLoadFromFile(
                context,
                identifier,
                domain,
                cookieFilePath,
                url,
              );
            }
            await this.page.goto(url as string, {
              waitUntil: 'domcontentloaded',
              timeout: 18000,
            });
            if (waitMs) await this.page.waitForTimeout(waitMs as number);
            const title = await this.page.title();

            const shouldSaveCookies =
              saveCookiesAfterNavigation === true ||
              (typeof saveCookiesAfterNavigation === 'string' &&
                saveCookiesAfterNavigation.toLowerCase() === 'true');
            const shouldAutoSaveOnLogin =
              autoSaveCookiesOnLoginSuccess === undefined
                ? true
                : autoSaveCookiesOnLoginSuccess === true ||
                  (typeof autoSaveCookiesOnLoginSuccess === 'string' &&
                    autoSaveCookiesOnLoginSuccess.toLowerCase() === 'true');
            let didSaveCookies = false;
            let savedCookiePath: string | undefined;

            const targetDomainKey =
              this.getDomainKeyFromUrlLike(domain) ||
              this.getDomainKeyFromUrlLike(url) ||
              this.getDomainKeyFromUrlLike(this.page.url());

            if (shouldSaveCookies) {
              const saved = await this.cookiesSaveToFile(
                context,
                identifier,
                domain,
                this.page.url(),
              );
              didSaveCookies = saved.saved;
              savedCookiePath = saved.filePath;
            } else if (
              shouldLoadCookies &&
              shouldAutoSaveOnLogin &&
              targetDomainKey
            ) {
              const loginOk = await this.isLikelyLoginSuccessForDomain(
                targetDomainKey,
                context,
                identifier,
              );
              if (loginOk) {
                const saved = await this.cookiesSaveToFile(
                  context,
                  identifier,
                  targetDomainKey,
                  this.page.url(),
                );
                didSaveCookies = saved.saved;
                savedCookiePath = saved.filePath;
              }
            }
            const draftPath = await this.appendSkillDraftStep(context, {
              groupDir: group.groupDir,
              groupId: group.groupId,
              identifier: group.effectiveIdentifier,
              action: 'navigate',
              status: 'pass',
              currentUrl: this.page.url(),
            });
            const cookieUserIdentifier =
              cookieLoadInfo?.userIdentifier ??
              (await this.resolveCookieIdentifier(context, identifier));
            return {
              success: true,
              data: {
                url,
                title,
                currentUrl: this.page.url(),
                didSaveCookies,
                savedCookiePath,
                cookieUserIdentifier,
                cookieLoadAttempted: shouldLoadCookies,
                cookieLoad: cookieLoadInfo,
                mobileContextApplied: mobileRequested,
                skillDraftPath: draftPath,
                skillDraftGroupId: group.groupId,
              },
              metadata: { durationMs: Date.now() - start },
            };
          } catch (err: any) {
            if (!saveOnError) {
              return {
                success: false,
                error: err?.message ?? String(err),
                metadata: { durationMs: Date.now() - start },
              };
            }

            const group = await this.resolveArtifactGroup({
              context,
              identifierParam: identifier,
              debugBaseDirParam: debugBaseDir,
              urlHint: typeof url === 'string' ? url : undefined,
            });
            const { groupId, groupDir, effectiveIdentifier } = group;

            const html = await this.page.content().catch(() => undefined);
            const artifacts = await this.saveDebugArtifacts({
              groupDir,
              groupId,
              identifier: effectiveIdentifier,
              createdByUserId: context.userId,
              url: url ? String(url) : undefined,
              action: 'navigate',
              errorMessage: err?.message ?? String(err),
              html: typeof html === 'string' ? html : undefined,
              screenshotFullPage: (fullPage as boolean | undefined) ?? true,
              maxSnapshotsPerGroup: Number(maxSnapshotsPerGroup ?? 5),
            });
            const draftPath = await this.appendSkillDraftStep(context, {
              groupDir,
              groupId,
              identifier: effectiveIdentifier,
              action: 'navigate',
              status: 'fail',
              currentUrl: this.page?.url?.(),
              error: err?.message ?? String(err),
              artifacts,
            });

            return {
              success: false,
              error: err?.message ?? String(err),
              data: {
                debugArtifacts: artifacts,
                skillDraftPath: draftPath,
                skillDraftGroupId: groupId,
              },
              metadata: { durationMs: Date.now() - start },
            };
          }
        }

        case 'screenshot': {
          await this.ensureBrowser();
          const buffer = await this.page.screenshot({
            fullPage: fullPage ?? true,
          });
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
          const textContent = await this.page.evaluate(
            () => document.body.innerText,
          );
          return {
            success: true,
            data: {
              text: (textContent as string).slice(0, 30000),
              currentUrl: this.page.url(),
            },
            metadata: { durationMs: Date.now() - start },
          };
        }

        case 'snapshot_save': {
          await this.ensureBrowser();
          const html = await this.page.content();
          const textContent = await this.page.evaluate(
            () => document.body.innerText,
          );

          const group = await this.resolveArtifactGroup({
            context,
            identifierParam: identifier,
            debugBaseDirParam: debugBaseDir,
            urlHint: this.page.url(),
          });
          const { groupId, groupDir, effectiveIdentifier } = group;

          const artifacts = await this.saveDebugArtifacts({
            groupDir,
            groupId,
            identifier: effectiveIdentifier,
            createdByUserId: context.userId,
            url: this.page.url(),
            action: 'snapshot_save',
            errorMessage: undefined,
            html,
            screenshotFullPage: (fullPage as boolean | undefined) ?? true,
            maxSnapshotsPerGroup: Number(maxSnapshotsPerGroup ?? 5),
          });
          const draftPath = await this.appendSkillDraftStep(context, {
            groupDir,
            groupId,
            identifier: effectiveIdentifier,
            action: 'snapshot_save',
            status: 'pass',
            currentUrl: this.page.url(),
            artifacts,
          });

          return {
            success: true,
            data: {
              debugArtifacts: artifacts,
              skillDraftPath: draftPath,
              skillDraftGroupId: groupId,
              text: (textContent as string).slice(0, 30000),
              currentUrl: this.page.url(),
            },
            metadata: { durationMs: Date.now() - start },
          };
        }

        case 'cookies_load': {
          const loaded = await this.cookiesLoadFromFile(
            context,
            identifier,
            domain,
            cookieFilePath,
            url,
          );
          return {
            success: loaded.loaded,
            error: loaded.loaded ? undefined : loaded.error,
            data: {
              ...loaded,
            },
            metadata: { durationMs: Date.now() - start },
          };
        }

        case 'cookies_save': {
          const saved = await this.cookiesSaveToFile(
            context,
            identifier,
            domain,
            url ?? this.page?.url(),
          );
          return {
            success: saved.saved,
            error: saved.saved ? undefined : saved.error,
            data: {
              ...saved,
            },
            metadata: { durationMs: Date.now() - start },
          };
        }

        case 'click': {
          await this.ensureBrowser();
          const selectorStr = String(selector ?? '').trim();
          const hintList = Array.isArray(textHints)
            ? (textHints as string[]).map((h) => String(h || '').trim())
            : [];
          const userIdentifier = await this.resolveCookieIdentifier(
            context,
            identifier,
          );
          const domPreset = await this.loadBrowserDomPresetForPage(
            context,
            this.page.url(),
          );
          const composerIntent = this.isComposerOpenIntent(
            selectorStr,
            hintList,
            domPreset,
          );
          const doAutoRetry =
            autoRetryOnFailure === undefined
              ? true
              : autoRetryOnFailure === true ||
                (typeof autoRetryOnFailure === 'string' &&
                  autoRetryOnFailure.toLowerCase() === 'true');
          const skipPublishVerify =
            skipPublishVerification === true ||
            (typeof skipPublishVerification === 'string' &&
              skipPublishVerification.toLowerCase() === 'true');
          const group = await this.resolveArtifactGroup({
            context,
            identifierParam: identifier,
            debugBaseDirParam: debugBaseDir,
            urlHint: this.page?.url?.(),
          });
          try {
            // First: try the element directly
            await this.page.waitForTimeout(100);
            await this.page.waitForSelector(selectorStr, {
              timeout: selectorTimeoutMs,
            });
            await this.page.click(selectorStr);
            if (waitMs) await this.page.waitForTimeout(waitMs as number);
            let publishVerifyReason: string | undefined;
            if (
              !composerIntent &&
              this.isPublishIntentSelector(selectorStr, domPreset) &&
              !skipPublishVerify
            ) {
              const verify = await this.verifyPublishSuccess(
                domPreset?.publishVerification,
              );
              if (!verify.ok) {
                let verifyArtifacts:
                  | Awaited<ReturnType<BrowserSkill['saveDebugArtifacts']>>
                  | undefined;
                if (saveOnError !== false) {
                  const html = await this.page.content().catch(() => undefined);
                  verifyArtifacts = await this.saveDebugArtifacts({
                    groupDir: group.groupDir,
                    groupId: group.groupId,
                    identifier: group.effectiveIdentifier,
                    createdByUserId: context.userId,
                    url: this.page.url(),
                    action: 'click',
                    selector: selectorStr,
                    errorMessage: `publish_verify:${verify.reason}`,
                    html: typeof html === 'string' ? html : undefined,
                    screenshotFullPage: (fullPage as boolean | undefined) ?? true,
                    maxSnapshotsPerGroup: Number(maxSnapshotsPerGroup ?? 5),
                  });
                }
                return {
                  success: false,
                  error:
                    `Publish click executed but not verified (${verify.reason}).` +
                    ' Screenshot/HTML saved under browser_debug when saveOnError is true.',
                  data: {
                    verifyReason: verify.reason,
                    skillDraftGroupId: group.groupId,
                    ...(verifyArtifacts
                      ? { debugArtifacts: verifyArtifacts }
                      : {}),
                  },
                  metadata: { durationMs: Date.now() - start },
                };
              }
              publishVerifyReason = verify.reason;
            }
            const draftPath = await this.appendSkillDraftStep(context, {
              groupDir: group.groupDir,
              groupId: group.groupId,
              identifier: group.effectiveIdentifier,
              action: 'click',
              status: 'pass',
              currentUrl: this.page.url(),
              selector: selectorStr,
            });
            return {
              success: true,
              data: {
                action: 'click',
                selector: selectorStr,
                currentUrl: this.page.url(),
                ...(publishVerifyReason != null
                  ? { verifyReason: publishVerifyReason }
                  : {}),
                skillDraftPath: draftPath,
                skillDraftGroupId: group.groupId,
              },
              metadata: { durationMs: Date.now() - start },
            };
          } catch (err: any) {
            if (!saveOnError) {
              return {
                success: false,
                error: err?.message ?? String(err),
                metadata: { durationMs: Date.now() - start },
              };
            }

            const groupForFail = await this.resolveArtifactGroup({
              context,
              identifierParam: identifier,
              debugBaseDirParam: debugBaseDir,
              urlHint: this.page.url(),
            });
            const {
              groupId,
              groupDir,
              effectiveIdentifier,
            } = groupForFail;

            const html = await this.page.content().catch(() => undefined);
            const artifacts = await this.saveDebugArtifacts({
              groupDir,
              groupId,
              identifier: effectiveIdentifier,
              createdByUserId: context.userId,
              url: this.page.url(),
              action: 'click',
              selector: selectorStr,
              errorMessage: err?.message ?? String(err),
              html: typeof html === 'string' ? html : undefined,
              screenshotFullPage: (fullPage as boolean | undefined) ?? true,
              maxSnapshotsPerGroup: Number(maxSnapshotsPerGroup ?? 5),
            });

            if (doAutoRetry && typeof html === 'string') {
              const hintCandidates = this.buildTextHintCandidateSelectors(
                'click',
                Array.isArray(textHints) ? (textHints as string[]) : [],
              );
              const presetCandidates = await this.getSitePresetSelectors(
                'click',
                this.page.url(),
                userIdentifier,
              );
              const candidates = [
                ...hintCandidates,
                ...presetCandidates,
                ...this.buildHeuristicCandidateSelectors(selectorStr),
              ];
              if (
                await this.shouldScrollAssistBeforeRetry(
                  this.page.url(),
                  userIdentifier,
                )
              ) {
                await this.page.mouse.wheel(0, 900).catch(() => undefined);
                await this.page.waitForTimeout(500);
                await this.page.mouse.wheel(0, -250).catch(() => undefined);
              }
              for (const cand of candidates) {
                try {
                  if (
                    composerIntent &&
                    this.isComposerStepDenyCandidate(cand, domPreset)
                  ) {
                    continue;
                  }
                  if (
                    typeof html === 'string' &&
                    html.length > 0 &&
                    !this.candidateSeemsPresentInHtml(cand, html)
                  ) {
                    continue;
                  }
                  const loc = this.page.locator(cand).first();
                  if ((await loc.count()) === 0) continue;
                  await loc.scrollIntoViewIfNeeded?.();
                  await loc.waitFor?.({ state: 'visible', timeout: 3000 });
                  await loc.click({ timeout: 3000 });
                  if (waitMs) await this.page.waitForTimeout(waitMs as number);
                  let retryPublishVerifyReason: string | undefined;
                  if (
                    !composerIntent &&
                    (this.isPublishIntentSelector(selectorStr, domPreset) ||
                      this.isPublishIntentSelector(cand, domPreset))
                  ) {
                    const verify = await this.verifyPublishSuccess(
                      domPreset?.publishVerification,
                    );
                    if (!verify.ok) {
                      continue;
                    }
                    retryPublishVerifyReason = verify.reason;
                  }
                  const draftPath = await this.appendSkillDraftStep(context, {
                    groupDir,
                    groupId,
                    identifier: effectiveIdentifier,
                    action: 'click',
                    status: 'retry_pass',
                    currentUrl: this.page.url(),
                    selector: selectorStr,
                    usedSelector: cand,
                    retried: true,
                    artifacts,
                  });
                  return {
                    success: true,
                    data: {
                      action: 'click',
                      selector: selectorStr,
                      currentUrl: this.page.url(),
                      retriedFrom: artifacts.groupId,
                      usedSelector: cand,
                      ...(retryPublishVerifyReason != null
                        ? { verifyReason: retryPublishVerifyReason }
                        : {}),
                      debugArtifacts: artifacts,
                      skillDraftPath: draftPath,
                      skillDraftGroupId: groupId,
                    },
                    metadata: { durationMs: Date.now() - start },
                  };
                } catch {
                  // try next candidate
                }
              }
            }

            const draftPath = await this.appendSkillDraftStep(context, {
              groupDir,
              groupId,
              identifier: effectiveIdentifier,
              action: 'click',
              status: doAutoRetry ? 'retry_fail' : 'fail',
              currentUrl: this.page?.url?.(),
              selector: selectorStr,
              retried: doAutoRetry,
              nextHint:
                'Review failed selector and try alternative aria-label/data-testid candidates from snapshot HTML.',
              error: err?.message ?? String(err),
              artifacts,
            });

            return {
              success: false,
              error: err?.message ?? String(err),
              data: {
                debugArtifacts: artifacts,
                attemptedSelector: selectorStr,
                skillDraftPath: draftPath,
                skillDraftGroupId: groupId,
              },
              metadata: { durationMs: Date.now() - start },
            };
          }
        }

        case 'type': {
          await this.ensureBrowser();
          const selectorStr = String(selector ?? '').trim();
          const textStr = String(text ?? '');
          const doAutoRetry =
            autoRetryOnFailure === undefined
              ? true
              : autoRetryOnFailure === true ||
                (typeof autoRetryOnFailure === 'string' &&
                  autoRetryOnFailure.toLowerCase() === 'true');
          const group = await this.resolveArtifactGroup({
            context,
            identifierParam: identifier,
            debugBaseDirParam: debugBaseDir,
            urlHint: this.page?.url?.(),
          });
          try {
            await this.page.waitForTimeout(100);
            const uploadPath = textStr.trim();
            if (
              this.isFileInputSelectorString(selectorStr) &&
              this.looksLikeExistingLocalFilePath(uploadPath)
            ) {
              const uploadLoc = this.page.locator(selectorStr).first();
              await uploadLoc.waitFor({
                state: 'attached',
                timeout: selectorTimeoutMs,
              });
              await uploadLoc.setInputFiles(uploadPath);
              const draftPath = await this.appendSkillDraftStep(context, {
                groupDir: group.groupDir,
                groupId: group.groupId,
                identifier: group.effectiveIdentifier,
                action: 'type',
                status: 'pass',
                currentUrl: this.page.url(),
                selector: selectorStr,
                text: uploadPath,
              });
              return {
                success: true,
                data: {
                  action: 'type',
                  selector: selectorStr,
                  text: uploadPath,
                  upload: true,
                  currentUrl: this.page.url(),
                  skillDraftPath: draftPath,
                  skillDraftGroupId: group.groupId,
                },
                metadata: { durationMs: Date.now() - start },
              };
            }

            await this.page.waitForSelector(selectorStr, {
              timeout: selectorTimeoutMs,
            });
            const directEditable = await this.page.$eval(
              selectorStr,
              (el: HTMLElement) => {
                const tag = (el.tagName || '').toLowerCase();
                const role = (el.getAttribute('role') || '').toLowerCase();
                const editable = (
                  el.getAttribute('contenteditable') || ''
                ).toLowerCase();
                if (tag === 'input') {
                  const t = (el as HTMLInputElement).type?.toLowerCase() ?? '';
                  if (t === 'file') return false;
                }
                return (
                  tag === 'input' ||
                  tag === 'textarea' ||
                  role === 'textbox' ||
                  editable === 'true' ||
                  editable === ''
                );
              },
            );
            if (!directEditable) {
              throw new Error(
                `Target selector is not editable: ${selectorStr || '(empty)'}`,
              );
            }
            await this.page.fill(selectorStr, textStr);
            const draftPath = await this.appendSkillDraftStep(context, {
              groupDir: group.groupDir,
              groupId: group.groupId,
              identifier: group.effectiveIdentifier,
              action: 'type',
              status: 'pass',
              currentUrl: this.page.url(),
              selector: selectorStr,
              text: textStr,
            });
            return {
              success: true,
              data: {
                action: 'type',
                selector: selectorStr,
                text: textStr,
                currentUrl: this.page.url(),
                skillDraftPath: draftPath,
                skillDraftGroupId: group.groupId,
              },
              metadata: { durationMs: Date.now() - start },
            };
          } catch (err: any) {
            if (!saveOnError) {
              return {
                success: false,
                error: err?.message ?? String(err),
                metadata: { durationMs: Date.now() - start },
              };
            }

            const groupForFail = await this.resolveArtifactGroup({
              context,
              identifierParam: identifier,
              debugBaseDirParam: debugBaseDir,
              urlHint: this.page.url(),
            });
            const {
              groupId,
              groupDir,
              effectiveIdentifier,
            } = groupForFail;

            const html = await this.page.content().catch(() => undefined);
            const artifacts = await this.saveDebugArtifacts({
              groupDir,
              groupId,
              identifier: effectiveIdentifier,
              createdByUserId: context.userId,
              url: this.page.url(),
              action: 'type',
              selector: selectorStr,
              text: textStr,
              errorMessage: err?.message ?? String(err),
              html: typeof html === 'string' ? html : undefined,
              screenshotFullPage: (fullPage as boolean | undefined) ?? true,
              maxSnapshotsPerGroup: Number(maxSnapshotsPerGroup ?? 5),
            });

            if (doAutoRetry && typeof html === 'string') {
              const userIdentifier = await this.resolveCookieIdentifier(
                context,
                identifier,
              );
              const hintCandidates = this.buildTextHintCandidateSelectors(
                'type',
                Array.isArray(textHints) ? (textHints as string[]) : [],
              );
              const presetCandidates = await this.getSitePresetSelectors(
                'type',
                this.page.url(),
                userIdentifier,
              );
              const candidates = [
                ...hintCandidates,
                ...presetCandidates,
                ...this.buildHeuristicCandidateSelectors(selectorStr),
              ];
              if (
                await this.shouldScrollAssistBeforeRetry(
                  this.page.url(),
                  userIdentifier,
                )
              ) {
                await this.page.mouse.wheel(0, 900).catch(() => undefined);
                await this.page.waitForTimeout(500);
                await this.page.mouse.wheel(0, -250).catch(() => undefined);
              }
              for (const cand of candidates) {
                try {
                  if (
                    typeof html === 'string' &&
                    html.length > 0 &&
                    !this.candidateSeemsPresentInHtml(cand, html)
                  ) {
                    continue;
                  }
                  const loc = this.page.locator(cand).first();
                  if ((await loc.count()) === 0) continue;
                  await loc.scrollIntoViewIfNeeded?.();
                  if (this.looksLikeExistingLocalFilePath(textStr)) {
                    const isFileIn = await this.isLocatorFileInput(loc);
                    if (isFileIn) {
                      await loc.waitFor({ state: 'attached', timeout: 3000 });
                      await loc.setInputFiles(textStr.trim());
                      const draftPath = await this.appendSkillDraftStep(context, {
                        groupDir,
                        groupId,
                        identifier: effectiveIdentifier,
                        action: 'type',
                        status: 'retry_pass',
                        currentUrl: this.page.url(),
                        selector: selectorStr,
                        usedSelector: cand,
                        text: textStr,
                        retried: true,
                        artifacts,
                      });
                      return {
                        success: true,
                        data: {
                          action: 'type',
                          selector: selectorStr,
                          text: textStr,
                          upload: true,
                          currentUrl: this.page.url(),
                          usedSelector: cand,
                          debugArtifacts: artifacts,
                          skillDraftPath: draftPath,
                          skillDraftGroupId: groupId,
                        },
                        metadata: { durationMs: Date.now() - start },
                      };
                    }
                  }
                  await loc.waitFor?.({ state: 'visible', timeout: 3000 });
                  const editable = await this.isLocatorEditable(loc);
                  if (!editable) continue;
                  try {
                    await loc.fill(textStr, { timeout: 3000 });
                  } catch {
                    await loc.type(textStr, { delay: 10, timeout: 3000 });
                  }
                  const draftPath = await this.appendSkillDraftStep(context, {
                    groupDir,
                    groupId,
                    identifier: effectiveIdentifier,
                    action: 'type',
                    status: 'retry_pass',
                    currentUrl: this.page.url(),
                    selector: selectorStr,
                    usedSelector: cand,
                    text: textStr,
                    retried: true,
                    artifacts,
                  });
                  return {
                    success: true,
                    data: {
                      action: 'type',
                      selector: selectorStr,
                      text: textStr,
                      currentUrl: this.page.url(),
                      usedSelector: cand,
                      debugArtifacts: artifacts,
                      skillDraftPath: draftPath,
                      skillDraftGroupId: groupId,
                    },
                    metadata: { durationMs: Date.now() - start },
                  };
                } catch {
                  // try next candidate
                }
              }
            }

            const draftPath = await this.appendSkillDraftStep(context, {
              groupDir,
              groupId,
              identifier: effectiveIdentifier,
              action: 'type',
              status: doAutoRetry ? 'retry_fail' : 'fail',
              currentUrl: this.page?.url?.(),
              selector: selectorStr,
              text: textStr,
              retried: doAutoRetry,
              nextHint:
                'Check input-like elements near the failed selector and retry with placeholder/aria-label based selectors.',
              error: err?.message ?? String(err),
              artifacts,
            });

            return {
              success: false,
              error: err?.message ?? String(err),
              data: {
                debugArtifacts: artifacts,
                attemptedSelector: selectorStr,
                skillDraftPath: draftPath,
                skillDraftGroupId: groupId,
              },
              metadata: { durationMs: Date.now() - start },
            };
          }
        }

        case 'evaluate': {
          await this.ensureBrowser();
          const rawScript = String(script ?? '').trim();
          // Playwright evaluates a string as an expression; top-level `return` is a syntax error.
          // Wrap “function-body-like” scripts into an IIFE so `return ...` works.
          const wrapped =
            /(^|\n)\s*return\b/.test(rawScript) || /;\s*return\b/.test(rawScript)
              ? `(() => {\n${rawScript}\n})()`
              : rawScript;
          const result = await this.page.evaluate(wrapped);
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
    } finally {
      this.releaseBrowserLock();
    }
  }

  private async ensureBrowser(options?: {
    forceRecreate?: boolean;
    contextOptions?: Record<string, unknown>;
  }): Promise<void> {
    const forceRecreate = options?.forceRecreate === true;
    if (this.browser && this.context && this.page) {
      const browserConnected =
        typeof this.browser?.isConnected === 'function'
          ? this.browser.isConnected()
          : true;
      const pageClosed =
        typeof this.page?.isClosed === 'function' ? this.page.isClosed() : false;
      if (browserConnected && !pageClosed && !forceRecreate) return;
    }

    // Clean stale references before creating a fresh session.
    try {
      await this.page?.close?.();
    } catch {
      // ignore
    }
    try {
      await this.context?.close?.();
    } catch {
      // ignore
    }
    try {
      await this.browser?.close?.();
    } catch {
      // ignore
    }
    this.page = null;
    this.context = null;
    this.browser = null;

    try {
      const { chromium } = await import('playwright');
      this.browser = await chromium.launch({ headless: true });
      const browserContext = await this.browser.newContext(
        (options?.contextOptions as any) ?? {},
      );
      this.context = browserContext;
      this.page = await browserContext.newPage();
    } catch {
      throw new Error(
        'Playwright not available. Install with: npx playwright install chromium',
      );
    }
  }
}
