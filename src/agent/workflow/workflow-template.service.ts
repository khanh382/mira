import { Injectable } from '@nestjs/common';

@Injectable()
export class WorkflowTemplateService {
  render(
    template: string | null | undefined,
    context: Record<string, unknown>,
  ): string | null {
    if (!template) return null;
    // Only replace explicit path placeholders like {input.title} / {nodes.<id>.content}.
    // Do not capture raw JSON braces in commandCode payloads.
    return template.replace(/\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g, (_m, key) => {
      const value = this.resolvePath(context, String(key).trim());
      if (value == null) return '';
      if (typeof value === 'string') return value;
      return JSON.stringify(value);
    });
  }

  private resolvePath(root: unknown, path: string): unknown {
    if (!path) return undefined;
    const parts = path.split('.');
    let cursor: any = root;
    for (const p of parts) {
      if (cursor == null || typeof cursor !== 'object') return undefined;
      cursor = cursor[p];
    }
    return cursor;
  }
}
