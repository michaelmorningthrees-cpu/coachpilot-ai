/**
 * Coach authentication backed by Firebase Authentication (Email/Password).
 *
 * Server-side SSR flow:
 *   1. Email + password are verified via the Identity Toolkit REST endpoint
 *      (signInWithPassword) using FIREBASE_API_KEY → returns an idToken.
 *   2. The idToken is exchanged (Admin SDK) for a session cookie stored as an
 *      httpOnly cookie (cp_coach). Subsequent requests verify the session
 *      cookie with the Admin SDK.
 *
 * Account management (create user, set/reset password) uses the Admin SDK.
 * Passwords are managed entirely by Firebase — we never store them ourselves.
 */

import crypto from 'crypto';
import { getAuthAdmin } from '../config/firebaseAdmin';
import { logger } from './logger';

/** Session cookie lifetime: 5 days (Firebase max is 14). */
export const COACH_SESSION_MS = 5 * 24 * 60 * 60 * 1000;

export interface SignInResult {
  uid: string;
  idToken: string;
}

function getApiKey(): string {
  const key = process.env.FIREBASE_API_KEY;
  if (!key) {
    throw new Error('FIREBASE_API_KEY is not set (required for coach login).');
  }
  return key;
}

/**
 * Verifies email + password via Firebase Identity Toolkit. Resolves with the
 * uid + idToken on success; throws a generic Error on failure (no detail
 * leakage). Never logs the password.
 */
export async function signInWithEmailPassword(
  email: string,
  password: string,
): Promise<SignInResult> {
  const url =
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' +
    encodeURIComponent(getApiKey());

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });

  const data = (await response.json()) as {
    idToken?: string;
    localId?: string;
    error?: { message?: string };
  };

  if (!response.ok || !data.idToken || !data.localId) {
    logger.warn(
      `[COACH AUTH] Sign-in failed (${data.error?.message ?? response.status}).`,
    );
    throw new Error('Invalid email or password.');
  }

  return { uid: data.localId, idToken: data.idToken };
}

/** Creates a Firebase session cookie from a freshly-minted idToken. */
export async function createCoachSessionCookie(idToken: string): Promise<string> {
  const auth = getAuthAdmin();
  if (!auth) {
    throw new Error('Firebase Auth is not configured.');
  }
  return auth.createSessionCookie(idToken, { expiresIn: COACH_SESSION_MS });
}

/**
 * Verifies a coach session cookie. Returns the uid, or null if invalid/revoked.
 */
export async function verifyCoachSession(cookie: string): Promise<string | null> {
  const auth = getAuthAdmin();
  if (!auth) {
    return null;
  }
  try {
    const decoded = await auth.verifySessionCookie(cookie, true);
    return decoded.uid;
  } catch {
    return null;
  }
}

/** Revokes all refresh tokens for a coach (used on logout-all / reset). */
export async function revokeCoachSessions(uid: string): Promise<void> {
  const auth = getAuthAdmin();
  if (!auth) {
    return;
  }
  await auth.revokeRefreshTokens(uid);
}

/** Generates a strong, human-typable temporary password. */
export function generateTempPassword(): string {
  // 9 random bytes → 12 base64url chars; prefix guarantees letter+digit+symbol.
  const random = crypto.randomBytes(9).toString('base64url');
  return `Cp7-${random}`;
}

/**
 * Creates (or updates) the Firebase Auth user for a coach's email and sets the
 * given password. Returns the uid. Used by the admin to issue/reset logins.
 */
export async function upsertCoachAuthUser(
  email: string,
  password: string,
): Promise<string> {
  const auth = getAuthAdmin();
  if (!auth) {
    throw new Error('Firebase Auth is not configured.');
  }

  try {
    const existing = await auth.getUserByEmail(email);
    await auth.updateUser(existing.uid, { password });
    await auth.revokeRefreshTokens(existing.uid);
    return existing.uid;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'auth/user-not-found') {
      throw error;
    }
  }

  const created = await auth.createUser({
    email,
    password,
    emailVerified: false,
  });
  return created.uid;
}

/** Updates a coach's own password (after first-login forced change). */
export async function updateCoachPassword(
  uid: string,
  newPassword: string,
): Promise<void> {
  const auth = getAuthAdmin();
  if (!auth) {
    throw new Error('Firebase Auth is not configured.');
  }
  await auth.updateUser(uid, { password: newPassword });
}
