import { createHmac, timingSafeEqual } from 'node:crypto';

export const UI_SESSION_COOKIE = 'emika_ui_session';

type SessionParts = { expiresAt: number; signature: string };

export function createUiSession(secret: string, ttlSeconds: number, nowMs = Date.now()): string {
  const expiresAt = Math.floor(nowMs / 1000) + Math.max(1, Math.floor(ttlSeconds));
  return `${expiresAt}.${sign(String(expiresAt), secret)}`;
}

export function verifyUiSession(token: string | undefined, secret: string, nowMs = Date.now()): boolean {
  const parts = parseToken(token);
  if (!parts || parts.expiresAt < Math.floor(nowMs / 1000)) return false;
  const expected = sign(String(parts.expiresAt), secret);
  const actualBytes = Buffer.from(parts.signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const item of cookieHeader.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    if (key === name) return item.slice(separator + 1).trim();
  }
  return undefined;
}

function parseToken(token: string | undefined): SessionParts | undefined {
  if (!token) return undefined;
  const separator = token.indexOf('.');
  if (separator <= 0 || separator === token.length - 1) return undefined;
  const expiresAt = Number(token.slice(0, separator));
  const signature = token.slice(separator + 1);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || !/^[A-Za-z0-9_-]+$/.test(signature)) return undefined;
  return { expiresAt, signature };
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}
