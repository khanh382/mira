import { Injectable } from '@nestjs/common';

@Injectable()
export class WorkflowConditionService {
  evaluate(
    expression: string | null | undefined,
    context: Record<string, unknown>,
  ): boolean {
    if (!expression || !expression.trim()) return true;
    const expr = this.replaceJsonPath(expression, context);

    try {
      // Internal-only expression engine for workflow conditions.
      const fn = new Function(`return Boolean(${expr});`);
      return Boolean(fn());
    } catch {
      return false;
    }
  }

  private replaceJsonPath(
    expression: string,
    context: Record<string, unknown>,
  ): string {
    return expression.replace(/\$\.([a-zA-Z0-9_\.]+)/g, (_m, path) => {
      const val = this.resolvePath(context, String(path));
      return JSON.stringify(val ?? null);
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
