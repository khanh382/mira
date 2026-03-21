import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { WorkspaceService } from './workspace.service';

/**
 * Sau khi `run_skill` lỗi và đã chép `$BRAIN_DIR/<user>/browser_debug/<draftId>/skill_draft.json`,
 * chạy nền (không await) để gộp `usedSelector` / URL từ `runStepLogs` vào
 * `$BRAIN_DIR/<user>/browser_dom_presets/<domain>.json` — chỉnh DOM mà không chặn luồng bootstrap/skill.
 */
@Injectable()
export class BrowserDomPresetLearnService {
  private readonly logger = new Logger(BrowserDomPresetLearnService.name);

  constructor(private readonly workspaceService: WorkspaceService) {}

  /**
   * Fire-and-forget: không chặn caller (skills_registry / bootstrap).
   */
  scheduleLearnFromBrowserDebugDraft(draftDir: string, userIdentifier: string): void {
    setImmediate(() => {
      void this.learnFromBrowserDebugDraft(draftDir, userIdentifier).catch((e) =>
        this.logger.warn(
          `browser_dom_preset_learn failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    });
  }

  private isValidPresetDomainBasename(b: string): boolean {
    return /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(String(b ?? '').trim());
  }

  private hostnameFromUrl(urlLike: string | undefined | null): string | null {
    if (!urlLike || typeof urlLike !== 'string') return null;
    const s = urlLike.trim();
    if (!s) return null;
    try {
      const normalized = /^https?:\/\//i.test(s) ? s : `https://${s}`;
      const u = new URL(normalized);
      return u.hostname.replace(/^www\./i, '').toLowerCase() || null;
    } catch {
      return null;
    }
  }

  /** Thử hậu tố từ cụ thể → rộng; ưu tiên file user, rồi shared (giống BrowserSkill). */
  private async resolvePresetDomainKeyForHost(
    host: string,
    userIdentifier: string,
  ): Promise<string | null> {
    const h = (host || '').toLowerCase().replace(/^www\./, '').trim();
    if (!h) return null;
    const labels = h.split('.').filter(Boolean);
    if (labels.length < 2) return null;
    const sharedDir = this.workspaceService.getSharedBrowserDomPresetsDir();
    const userDir = this.workspaceService.getUserBrowserDomPresetsDir(userIdentifier);
    for (let start = 0; start < labels.length - 1; start++) {
      const candidate = labels.slice(start).join('.');
      if (!this.isValidPresetDomainBasename(candidate)) continue;
      const userPath = path.join(userDir, `${candidate}.json`);
      const ust = await fs.stat(userPath).catch(() => null);
      if (ust?.isFile()) return candidate;
      const sharedPath = path.join(sharedDir, `${candidate}.json`);
      const sst = await fs.stat(sharedPath).catch(() => null);
      if (sst?.isFile()) return candidate;
    }
    /** Fallback: eTLD+1 kiểu `facebook.com` */
    return labels.length >= 2
      ? `${labels[labels.length - 2]}.${labels[labels.length - 1]}`
      : null;
  }

  private async resolveWritePathForDomainKey(
    domainKey: string,
    userIdentifier: string,
  ): Promise<string> {
    const userDir = this.workspaceService.getUserBrowserDomPresetsDir(userIdentifier);
    await fs.mkdir(userDir, { recursive: true });
    return path.join(userDir, `${domainKey}.json`);
  }

  private async readJsonFile(p: string): Promise<Record<string, unknown> | null> {
    try {
      const t = await fs.readFile(p, 'utf8');
      const parsed = JSON.parse(t) as unknown;
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private normalizeSelectorList(s: string): string[] {
    const t = String(s ?? '').trim();
    if (!t) return [];
    /** Giữ nguyên một selector; chỉ tách khi có dấu phẩy rõ ràng (list Playwright). */
    if (!t.includes(',')) return [t];
    const parts = t.split(',').map((x) => x.trim()).filter(Boolean);
    return parts.length ? parts : [t];
  }

  private mergeUniqueArrays(
    existing: string[] | undefined,
    additions: string[],
    maxTotal: number,
  ): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (x: string) => {
      const k = x.trim();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push(k);
    };
    for (const x of existing ?? []) add(x);
    for (const x of additions) {
      if (out.length >= maxTotal) break;
      add(x);
    }
    return out;
  }

  private async learnFromBrowserDebugDraft(
    draftDir: string,
    userIdentifier: string,
  ): Promise<void> {
    const draftPath = path.join(draftDir, 'skill_draft.json');
    const raw = await fs.readFile(draftPath, 'utf8').catch(() => '');
    if (!raw) return;

    let draft: Record<string, unknown>;
    try {
      draft = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const runLogs = Array.isArray(draft.runStepLogs)
      ? (draft.runStepLogs as Record<string, unknown>[])
      : [];

    /** URL để suy domain: ưu tiên bước navigate, sau đó lastUrl / currentUrl cuối. */
    let hostHint: string | null = null;
    if (typeof draft.lastUrl === 'string') {
      hostHint = this.hostnameFromUrl(draft.lastUrl);
    }
    for (const log of runLogs) {
      if (String(log?.action ?? '') === 'navigate' && log.currentUrl) {
        hostHint = this.hostnameFromUrl(String(log.currentUrl)) ?? hostHint;
      }
    }
    if (!hostHint) {
      for (let i = runLogs.length - 1; i >= 0; i--) {
        const u = runLogs[i]?.currentUrl;
        if (u) {
          hostHint = this.hostnameFromUrl(String(u));
          break;
        }
      }
    }
    if (!hostHint) {
      this.logger.debug(`browser_dom_preset_learn: no host in ${draftPath}`);
      return;
    }

    const domainKey = await this.resolvePresetDomainKeyForHost(
      hostHint,
      userIdentifier,
    );
    if (!domainKey || !this.isValidPresetDomainBasename(domainKey)) return;

    const clicks: string[] = [];
    const types: string[] = [];

    for (const log of runLogs) {
      const action = String(log?.action ?? '').trim();
      const used = log?.usedSelector;
      if (typeof used !== 'string' || !used.trim()) continue;
      const parts = this.normalizeSelectorList(used);
      if (action === 'click') clicks.push(...parts);
      else if (action === 'type') types.push(...parts);
    }

    /** Bổ sung từ `steps` (browser skill draft) nếu có retry_pass + usedSelector */
    const steps = Array.isArray(draft.steps)
      ? (draft.steps as Record<string, unknown>[])
      : [];
    for (const st of steps) {
      if (String(st?.status ?? '') !== 'retry_pass') continue;
      const u = st?.usedSelector;
      if (typeof u !== 'string' || !u.trim()) continue;
      const action = String(st?.action ?? '').trim();
      const parts = this.normalizeSelectorList(u);
      if (action === 'click') clicks.push(...parts);
      else if (action === 'type') types.push(...parts);
    }

    if (!clicks.length && !types.length) return;

    const writePath = await this.resolveWritePathForDomainKey(
      domainKey,
      userIdentifier,
    );
    const sharedPath = path.join(
      this.workspaceService.getSharedBrowserDomPresetsDir(),
      `${domainKey}.json`,
    );

    let base: Record<string, unknown> =
      (await this.readJsonFile(writePath)) ??
      (await this.readJsonFile(sharedPath)) ??
      { version: 1 };

    const prevClick = Array.isArray(base.click)
      ? (base.click as unknown[]).map(String)
      : [];
    const prevType = Array.isArray(base.type)
      ? (base.type as unknown[]).map(String)
      : [];

    const maxEach = 80;
    base.click = this.mergeUniqueArrays(prevClick, clicks, maxEach);
    base.type = this.mergeUniqueArrays(prevType, types, maxEach);
    if (base.version == null) base.version = 1;

    await fs.writeFile(writePath, JSON.stringify(base, null, 2), 'utf8');
    this.logger.log(
      `browser_dom_preset_learn: merged ${clicks.length} click + ${types.length} type hints → ${writePath}`,
    );
  }
}
