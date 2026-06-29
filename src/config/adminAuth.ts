/**
 * Minimal admin auth for the onboarding dashboard (pilot-grade).
 *
 * A single shared password (ADMIN_PASSWORD) gates the /admin pages. On login we
 * set an httpOnly cookie holding a derived session token (never the password
 * itself). Comparisons are constant-time.
 */

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

const COOKIE_NAME = 'cp_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function getAdminPassword(): string | undefined {
  const value = process.env.ADMIN_PASSWORD;
  return value && value.trim() !== '' ? value : undefined;
}

/** Derived, opaque session token stored in the cookie (not the password). */
export function adminSessionToken(): string | null {
  const password = getAdminPassword();
  if (!password) {
    return null;
  }
  return crypto.createHash('sha256').update(`coachpilot:${password}`).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export function verifyAdminPassword(input: string): boolean {
  const password = getAdminPassword();
  if (!password) {
    return false;
  }
  return safeEqual(input, password);
}

export function isAdminConfigured(): boolean {
  return getAdminPassword() !== undefined;
}

export function setAdminCookie(res: Response): void {
  const token = adminSessionToken();
  if (!token) {
    return;
  }
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS,
  });
}

export function clearAdminCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME);
}

/** Express middleware: allows the request only with a valid admin cookie. */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = adminSessionToken();
  if (!expected) {
    res
      .status(500)
      .send('ADMIN_PASSWORD is not set. Configure it in .env to use the dashboard.');
    return;
  }

  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const token = cookies?.[COOKIE_NAME];
  if (token && safeEqual(token, expected)) {
    next();
    return;
  }

  res.redirect('/admin/login');
}
