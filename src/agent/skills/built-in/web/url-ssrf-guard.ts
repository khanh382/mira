/**
 * Chặn SSRF: chỉ cho phép fetch tới URL công khai (không private/metadata/link-local).
 * Gọi từ `web_fetch` **chỉ khi** môi trường production (xem `WebFetchSkill.isSsrfEnforced`).
 * Owner có thể bật bypass qua WEB_FETCH_ALLOW_PRIVATE_URLS=true khi SSRF đang bật.
 */
import * as dns from 'dns/promises';
import * as net from 'net';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
]);

export function isPrivateOrBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((x) => parseInt(x, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  return false;
}

/** IPv6: loopback, link-local, unique local, 4to6 mapped private — kiểm tra đơn giản theo prefix. */
export function isPrivateOrBlockedIPv6(ip: string): boolean {
  const norm = ip.toLowerCase().trim();
  if (norm === '::1' || norm === '0:0:0:0:0:0:0:1') return true;
  if (norm.startsWith('fe80:')) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(norm)) return true;
  if (norm.startsWith('::ffff:')) {
    const v4 = norm.replace(/^::ffff:/i, '');
    if (net.isIPv4(v4)) return isPrivateOrBlockedIPv4(v4);
  }
  return false;
}

function classifyIp(ip: string): 'v4' | 'v6' | 'invalid' {
  if (net.isIPv4(ip)) return 'v4';
  if (net.isIPv6(ip)) return 'v6';
  return 'invalid';
}

async function resolveHostnameIps(hostname: string): Promise<string[]> {
  const out: string[] = [];
  try {
    out.push(...(await dns.resolve4(hostname)));
  } catch {
    /* no A */
  }
  try {
    out.push(...(await dns.resolve6(hostname)));
  } catch {
    /* no AAAA */
  }
  return out;
}

function hostBlockedByName(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  return false;
}

export function isValidPublicHttpUrlSyntax(urlStr: string): URL {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error('URL không hợp lệ');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Chỉ cho phép http(s)');
  }
  if (!u.hostname) throw new Error('Thiếu hostname');
  return u;
}

/**
 * Kiểm tra URL trước khi fetch: chặn private IP, metadata cloud, localhost.
 * `allowPrivate`: true khi owner + WEB_FETCH_ALLOW_PRIVATE_URLS=true.
 */
export async function assertUrlSafeForFetch(
  urlStr: string,
  options: { allowPrivate: boolean },
): Promise<void> {
  if (options.allowPrivate) return;

  const u = isValidPublicHttpUrlSyntax(urlStr);
  const host = u.hostname;

  if (hostBlockedByName(host)) {
    throw new Error(
      'URL bị chặn (localhost/metadata) — không fetch nội bộ từ tool này.',
    );
  }

  const kind = classifyIp(host);
  if (kind === 'v4') {
    if (isPrivateOrBlockedIPv4(host)) {
      throw new Error('URL trỏ tới IPv4 nội bộ / bị chặn.');
    }
    return;
  }
  if (kind === 'v6') {
    if (isPrivateOrBlockedIPv6(host)) {
      throw new Error('URL trỏ tới IPv6 nội bộ / bị chặn.');
    }
    return;
  }

  const ips = await resolveHostnameIps(host);
  if (ips.length === 0) {
    throw new Error('Không phân giải được hostname (DNS).');
  }
  for (const ip of ips) {
    const t = classifyIp(ip);
    if (t === 'v4' && isPrivateOrBlockedIPv4(ip)) {
      throw new Error(
        `Hostname phân giải ra IP nội bộ (${ip}) — bị chặn SSRF.`,
      );
    }
    if (t === 'v6' && isPrivateOrBlockedIPv6(ip)) {
      throw new Error(
        `Hostname phân giải ra IPv6 nội bộ (${ip}) — bị chặn SSRF.`,
      );
    }
  }
}
