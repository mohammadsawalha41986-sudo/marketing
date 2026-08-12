/**
 * Opaque session tokens in an HTTP-only cookie.
 *
 * The cookie holds a random 256-bit token; the database stores only its SHA-256
 * hash, so a database leak does not hand over live sessions. Lookups are by
 * hash, which is a constant-length indexed equality check.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { cookieSecure, env } from '../env.js';
import { prisma } from './prisma.js';

export const SESSION_COOKIE = 'mos_session';
export const CSRF_COOKIE = 'mos_csrf';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function expiryDate(): Date {
  return new Date(Date.now() + env.SESSION_TTL_HOURS * 3600 * 1000);
}

export async function createSession(
  userId: string,
  meta: { userAgent?: string; ip?: string },
): Promise<{ token: string; csrf: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = expiryDate();

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      userAgent: meta.userAgent?.slice(0, 500),
      ip: meta.ip?.slice(0, 100),
      expiresAt,
    },
  });

  return { token, csrf: newToken(), expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function destroyAllSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

/** Resolve a cookie token to its user, dropping the row if it has expired. */
export async function resolveSession(token: string) {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (!session.user.isActive) return null;
  return session;
}

export function setSessionCookies(res: Response, token: string, csrf: string, expiresAt: Date): void {
  const common = {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
  };
  res.cookie(SESSION_COOKIE, token, common);
  // Readable by the SPA so it can echo the value back in a header.
  res.cookie(CSRF_COOKIE, csrf, { ...common, httpOnly: false });
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

/** Constant-time compare for the double-submit CSRF check. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Housekeeping for expired rows; called on a timer from index.ts. */
export async function pruneExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  return count;
}
