import crypto from 'crypto';

const AUTH_SECRET = process.env.SECRET_KEY || 'pvc-studio-stable-signing-secret-2026';
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export function signAuthToken(userId: number): string {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = `${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyAuthToken(token: string | undefined | null): number | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [uidStr, expStr, sig] = parts;
  const payload = `${uidStr}.${expStr}`;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  const uid = parseInt(uidStr, 10);
  return Number.isFinite(uid) && uid > 0 ? uid : null;
}

export function isHttpsRequest(req: { secure?: boolean; headers?: Record<string, unknown> }): boolean {
  const proto = String(req.headers?.['x-forwarded-proto'] || '').toLowerCase();
  return Boolean(req.secure || proto.includes('https'));
}

export function buildCookieHeader(
  name: string,
  value: string,
  opts: { maxAgeSec?: number; httpOnly?: boolean; isHttps: boolean }
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
  if (opts.maxAgeSec !== undefined) {
    parts.push(`Max-Age=${opts.maxAgeSec}`);
  }
  if (opts.httpOnly) {
    parts.push('HttpOnly');
  }
  if (opts.isHttps) {
    parts.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  return parts.join('; ');
}
