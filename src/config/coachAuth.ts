/**
 * Coach session middleware.
 *
 * Reads the `cp_coach` Firebase session cookie, verifies it, loads the linked
 * coach and attaches it to req.coach. Unauthenticated requests are redirected
 * to the coach login page. While a coach still has a temporary password, all
 * coach routes (except the change-password and logout routes) redirect to the
 * forced password-change page.
 */

import { Request, Response, NextFunction } from 'express';
import { verifyCoachSession, COACH_SESSION_MS } from '../services/coachAuthService';
import { getCoachByAuthUid } from '../services/coachResolverService';

export const COACH_COOKIE = 'cp_coach';

export function setCoachCookie(res: Response, sessionCookie: string): void {
  res.cookie(COACH_COOKIE, sessionCookie, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COACH_SESSION_MS,
  });
}

export function clearCoachCookie(res: Response): void {
  res.clearCookie(COACH_COOKIE);
}

/** Paths a logged-in-but-must-change-password coach is still allowed to hit. */
const PASSWORD_CHANGE_ALLOWLIST = new Set([
  '/coach/change-password',
  '/coach/logout',
]);

export async function requireCoach(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const sessionCookie = cookies?.[COACH_COOKIE];

  if (!sessionCookie) {
    res.redirect('/coach/login');
    return;
  }

  const uid = await verifyCoachSession(sessionCookie);
  if (!uid) {
    clearCoachCookie(res);
    res.redirect('/coach/login');
    return;
  }

  const coach = await getCoachByAuthUid(uid);
  if (!coach) {
    // Authenticated Firebase user with no linked coach → not authorized here.
    clearCoachCookie(res);
    res.redirect('/coach/login?error=nolink');
    return;
  }

  // Force the temporary-password change before anything else.
  if (coach.mustChangePassword && !PASSWORD_CHANGE_ALLOWLIST.has(req.path)) {
    req.coach = coach;
    res.redirect('/coach/change-password');
    return;
  }

  req.coach = coach;
  next();
}
