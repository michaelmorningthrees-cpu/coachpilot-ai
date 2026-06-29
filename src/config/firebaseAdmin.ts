/**
 * Firebase Admin initialization for Firestore-backed persistence.
 *
 * Credentials come from environment variables:
 *   - FIREBASE_PROJECT_ID
 *   - FIREBASE_CLIENT_EMAIL
 *   - FIREBASE_PRIVATE_KEY  (literal "\n" sequences are converted to newlines)
 *
 * Initialization is lazy and safe: if credentials are not configured, callers
 * receive `null` and degrade gracefully (e.g. local curl testing keeps working
 * without Firestore). The private key is never logged.
 */

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import {
  getFirestore as getAdminFirestore,
  Firestore,
} from 'firebase-admin/firestore';
import { getAuth as getAdminAuth, Auth } from 'firebase-admin/auth';
import { logger } from '../services/logger';

let cachedDb: Firestore | null = null;
let cachedAuth: Auth | null = null;
let warnedMissing = false;

/**
 * Whether all required Firebase env vars are present.
 */
export function isFirestoreConfigured(): boolean {
  return Boolean(
    process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY,
  );
}

/**
 * Ensures the Firebase Admin app is initialized exactly once. Returns true when
 * the app is ready, false when credentials are missing or init failed.
 */
function ensureApp(): boolean {
  if (getApps().length > 0) {
    return true;
  }

  if (!isFirestoreConfigured()) {
    if (!warnedMissing) {
      logger.warn(
        '[FIRESTORE] Not configured (FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY missing). ' +
          'Persistence, idempotency and coach auth are disabled — degraded mode.',
      );
      warnedMissing = true;
    }
    return false;
  }

  try {
    // .env stores newlines as the literal characters "\n"; restore them.
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY ?? '').replace(
      /\\n/g,
      '\n',
    );

    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    });
    logger.info('[FIRESTORE] Firebase Admin initialized.');
    return true;
  } catch (error) {
    // Never log the credentials themselves — only the failure.
    logger.error('[FIRESTORE] Failed to initialize Firebase Admin.', error);
    return false;
  }
}

/**
 * Returns a cached Firestore client, initializing Firebase Admin on first use.
 * Returns null (logging a one-time warning) when credentials are not set.
 */
export function getFirestore(): Firestore | null {
  if (cachedDb) {
    return cachedDb;
  }
  if (!ensureApp()) {
    return null;
  }
  cachedDb = getAdminFirestore();
  return cachedDb;
}

/**
 * Returns a cached Firebase Auth client (Admin SDK), or null when Firebase is
 * not configured. Used for coach login session cookies and user management.
 */
export function getAuthAdmin(): Auth | null {
  if (cachedAuth) {
    return cachedAuth;
  }
  if (!ensureApp()) {
    return null;
  }
  cachedAuth = getAdminAuth();
  return cachedAuth;
}
