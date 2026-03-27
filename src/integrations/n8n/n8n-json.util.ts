function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Canonical JSON stringify with stable key order.
 * n8n side must use the same canonicalization before signing.
 */
export function canonicalJsonStringify(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        out[k] = normalize(v[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(normalize(value));
}

