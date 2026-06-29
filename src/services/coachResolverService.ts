/**
 * Resolves which coach an incoming message belongs to.
 *
 * Routing: a WhatsApp Business phone number (phone_number_id in the webhook
 * metadata) maps to exactly one coach. For local/curl testing where metadata is
 * absent, callers fall back to DEFAULT_COACH_ID.
 *
 * Reads from the Firestore `coaches` collection (document id = coachId).
 */

import { getFirestore } from '../config/firebaseAdmin';
import { logger } from './logger';
import { Coach } from '../types/coach';

const COLLECTION = 'coaches';

// --- Lightweight in-memory cache (Firestore stays the source of truth) ------
// Active coaches are cached for a short TTL to avoid a Firestore read on every
// inbound message. Inactive coaches are never cached.
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  coach: Coach;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

const idKey = (coachId: string): string => `id:${coachId}`;
const phoneKey = (phoneNumberId: string): string => `phone:${phoneNumberId}`;

function cacheLookup(key: string): Coach | null {
  const entry = cache.get(key);
  if (!entry) {
    logger.info(`[COACH CACHE MISS] key=${key}`);
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    logger.info(`[COACH CACHE MISS] key=${key} (expired)`);
    return null;
  }
  logger.info(`[COACH CACHE HIT] key=${key}`);
  return entry.coach;
}

/** Caches an active coach under both its id and phoneNumberId keys. */
function cacheStore(coach: Coach): void {
  const expiresAt = Date.now() + CACHE_TTL_MS;
  cache.set(idKey(coach.coachId), { coach, expiresAt });
  if (coach.whatsapp?.phoneNumberId) {
    cache.set(phoneKey(coach.whatsapp.phoneNumberId), { coach, expiresAt });
  }
  logger.info(`[COACH CACHE SET] coachId=${coach.coachId}`);
}

/** Test helper: clears the in-memory coach cache. */
export function resetCoachCache(): void {
  cache.clear();
}

/**
 * Returns the coach only if active; otherwise logs a clear error and returns
 * null (so it is never cached or used for the flow).
 */
function ensureActive(coach: Coach): Coach | null {
  if (coach.status !== 'active') {
    logger.error(
      `[COACH RESOLVER] Coach ${coach.coachId} is not active (status=${coach.status}); refusing to serve.`,
    );
    return null;
  }
  return coach;
}

/**
 * The fallback coach id used for local/curl testing when the webhook payload
 * has no metadata.phone_number_id.
 */
export function getDefaultCoachId(): string | undefined {
  return process.env.DEFAULT_COACH_ID;
}

/**
 * Returns the coach with the given id, or null if not found / Firestore is
 * unavailable.
 */
export async function getCoachById(coachId: string): Promise<Coach | null> {
  const cached = cacheLookup(idKey(coachId));
  if (cached) {
    return cached;
  }

  const db = getFirestore();
  if (!db) {
    logger.warn('[COACH RESOLVER] Firestore unavailable; cannot resolve coach.');
    return null;
  }

  try {
    const snap = await db.collection(COLLECTION).doc(coachId).get();
    if (!snap.exists) {
      return null;
    }
    const coach = ensureActive(snap.data() as Coach);
    if (coach) {
      cacheStore(coach);
    }
    return coach;
  } catch (error) {
    logger.error(`[COACH RESOLVER] getCoachById(${coachId}) failed.`, error);
    return null;
  }
}

/**
 * Returns the coach by id WITHOUT the active-status filter or cache. Used by the
 * OAuth flow, which must operate on not-yet-active (setup_pending) coaches.
 */
export async function getCoachByIdRaw(coachId: string): Promise<Coach | null> {
  const db = getFirestore();
  if (!db) {
    logger.warn('[COACH RESOLVER] Firestore unavailable; cannot resolve coach.');
    return null;
  }

  try {
    const snap = await db.collection(COLLECTION).doc(coachId).get();
    return snap.exists ? (snap.data() as Coach) : null;
  } catch (error) {
    logger.error(`[COACH RESOLVER] getCoachByIdRaw(${coachId}) failed.`, error);
    return null;
  }
}

/**
 * Returns the coach linked to a Firebase Auth uid, or null. No status filter /
 * cache — used by coach-login authorization.
 */
export async function getCoachByAuthUid(authUid: string): Promise<Coach | null> {
  const db = getFirestore();
  if (!db) {
    return null;
  }
  try {
    const query = await db
      .collection(COLLECTION)
      .where('authUid', '==', authUid)
      .limit(1)
      .get();
    return query.empty ? null : (query.docs[0].data() as Coach);
  } catch (error) {
    logger.error(`[COACH RESOLVER] getCoachByAuthUid(${authUid}) failed.`, error);
    return null;
  }
}

/**
 * Returns the coach whose WhatsApp phone number id matches, or null.
 */
export async function getCoachByWhatsAppPhoneNumberId(
  phoneNumberId: string,
): Promise<Coach | null> {
  const cached = cacheLookup(phoneKey(phoneNumberId));
  if (cached) {
    return cached;
  }

  const db = getFirestore();
  if (!db) {
    logger.warn('[COACH RESOLVER] Firestore unavailable; cannot resolve coach.');
    return null;
  }

  try {
    const query = await db
      .collection(COLLECTION)
      .where('whatsapp.phoneNumberId', '==', phoneNumberId)
      .limit(1)
      .get();

    if (query.empty) {
      return null;
    }
    const coach = ensureActive(query.docs[0].data() as Coach);
    if (coach) {
      cacheStore(coach);
    }
    return coach;
  } catch (error) {
    logger.error(
      `[COACH RESOLVER] getCoachByWhatsAppPhoneNumberId(${phoneNumberId}) failed.`,
      error,
    );
    return null;
  }
}

/**
 * Dumps diagnostics when a coach lookup fails: the incoming phone_number_id,
 * the total number of coaches, and every registered phoneNumberId. Helps debug
 * mis-routed webhooks (wrong/unknown phone number id).
 */
export async function logCoachLookupFailure(
  incomingPhoneNumberId: string | undefined,
): Promise<void> {
  const db = getFirestore();
  if (!db) {
    logger.warn(
      `[COACH RESOLVER] No coach for phone_number_id=${incomingPhoneNumberId ?? '(none)'}; Firestore unavailable.`,
    );
    return;
  }

  try {
    const snap = await db.collection(COLLECTION).get();
    const registered = snap.docs
      .map((doc) => {
        const coach = doc.data() as Coach;
        return `${coach.coachId}\nphoneNumberId=${coach.whatsapp?.phoneNumberId ?? '(none)'}`;
      })
      .join('\n\n');

    logger.warn(
      `[COACH RESOLVER] No coach matched.\n` +
        `Incoming:\n${incomingPhoneNumberId ?? '(none)'}\n\n` +
        `Total coaches: ${snap.size}\n` +
        `Registered:\n${registered || '(none)'}`,
    );
  } catch (error) {
    logger.error('[COACH RESOLVER] Failed to dump coach diagnostics.', error);
  }
}

/**
 * Resolves the coach for an incoming webhook. Uses phoneNumberId when present
 * (real Meta payloads). When it is missing, falls back to DEFAULT_COACH_ID
 * ONLY in development (local curl); production requires a real phone_number_id.
 * Returns null with diagnostics if no coach can be resolved.
 */
export async function resolveCoachForWebhook(
  phoneNumberId: string | undefined,
): Promise<Coach | null> {
  if (phoneNumberId) {
    const coach = await getCoachByWhatsAppPhoneNumberId(phoneNumberId);
    if (!coach) {
      await logCoachLookupFailure(phoneNumberId);
    }
    return coach;
  }

  // No phone_number_id in the payload (e.g. local curl tests).
  const isProduction = (process.env.NODE_ENV ?? 'development') === 'production';
  if (isProduction) {
    logger.error(
      '[COACH RESOLVER] Missing metadata.phone_number_id in production; refusing DEFAULT_COACH_ID fallback.',
    );
    return null;
  }

  const defaultCoachId = getDefaultCoachId();
  if (!defaultCoachId) {
    logger.error(
      '[COACH RESOLVER] No phone_number_id in payload and DEFAULT_COACH_ID is not set.',
    );
    return null;
  }

  logger.info(
    `[COACH RESOLVER] No phone_number_id; using DEFAULT_COACH_ID=${defaultCoachId} (development only).`,
  );
  const coach = await getCoachById(defaultCoachId);
  if (!coach) {
    logger.error(
      `[COACH RESOLVER] DEFAULT_COACH_ID=${defaultCoachId} not found in Firestore. Run "npm run seed:coach".`,
    );
  }
  return coach;
}
