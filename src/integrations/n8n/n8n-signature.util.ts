import { createHmac, timingSafeEqual } from 'crypto';
import { canonicalJsonStringify } from './n8n-json.util';

export interface ISignedHeaders {
  'x-mira-ts': string;
  'x-mira-nonce': string;
  'x-mira-signature': string;
}

export function computeMiraSignature(args: {
  secret: string;
  ts: string;
  nonce: string;
  body: unknown;
}): string {
  const canonical = canonicalJsonStringify(args.body);
  const msg = `${args.ts}.${args.nonce}.${canonical}`;
  return createHmac('sha256', args.secret).update(msg).digest('hex');
}

export function buildSignedHeaders(args: {
  secret: string;
  tsMs?: number;
  nonce?: string;
  body: unknown;
}): ISignedHeaders {
  const ts = String(args.tsMs ?? Date.now());
  const nonce =
    args.nonce ??
    // small, URL-safe nonce
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const signature = computeMiraSignature({
    secret: args.secret,
    ts,
    nonce,
    body: args.body,
  });
  return {
    'x-mira-ts': ts,
    'x-mira-nonce': nonce,
    'x-mira-signature': signature,
  };
}

export function verifyMiraSignature(args: {
  secret: string;
  ts: string;
  nonce: string;
  signature: string;
  body: unknown;
}): boolean {
  const expected = computeMiraSignature({
    secret: args.secret,
    ts: args.ts,
    nonce: args.nonce,
    body: args.body,
  });
  try {
    return timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(args.signature, 'hex'),
    );
  } catch {
    return false;
  }
}

