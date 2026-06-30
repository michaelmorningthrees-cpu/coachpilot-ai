/**
 * Firestore-backed conversation context for CoachPilot AI (multi-coach).
 *
 * Remembers, per (coach, student phone), the last suggested slot and detected
 * language so a short follow-up like "ok" / "好" can be turned into a booking.
 *
 * Document id = `${coachId}_${studentPhone}` so the same student can talk to
 * different coaches independently. Each context expires 30 minutes after the
 * last update; an expired context is treated as absent and deleted on read.
 *
 * Degrades gracefully: when Firestore is not configured, reads return null and
 * writes are no-ops so local/dev flows keep working.
 */

import { DateTime } from 'luxon';
import { logger, maskPhone } from './logger';
import { getFirestore } from '../config/firebaseAdmin';

export type Language = 'zh' | 'en';

const COLLECTION = 'conversation_contexts';
const TTL_MINUTES = 30;

export interface SuggestedSlot {
  startISO: string;
  endISO: string;
  displayTextEn: string;
  displayTextZh: string;
}

/** A booking we actually created, remembered so the student can cancel it. */
export interface BookedSlot {
  eventId: string;
  startISO: string;
  endISO: string;
  displayTextEn: string;
  displayTextZh: string;
}

export interface ConversationContext {
  coachId: string;
  studentPhone: string;
  lastIntent: string;
  lastSuggestedSlot: SuggestedSlot | null;
  lastBooking: BookedSlot | null;
  language: Language;
  updatedAt: string;
  expiresAt: string;
}

/**
 * Detects whether a message is Chinese/Cantonese ("zh") or English ("en").
 * Any Han character present → "zh", otherwise "en". (Pure; no I/O.)
 */
export function detectLanguage(message: string): Language {
  return /[\u4e00-\u9fff]/.test(message) ? 'zh' : 'en';
}

function docIdFor(coachId: string, studentPhone: string): string {
  return `${coachId}_${studentPhone}`;
}

function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) {
    return false;
  }
  const expiry = DateTime.fromISO(expiresAt);
  return expiry.isValid && expiry.toMillis() <= Date.now();
}

async function readRaw(
  coachId: string,
  studentPhone: string,
): Promise<ConversationContext | null> {
  const db = getFirestore();
  if (!db) {
    return null;
  }
  const snap = await db
    .collection(COLLECTION)
    .doc(docIdFor(coachId, studentPhone))
    .get();
  return snap.exists ? (snap.data() as ConversationContext) : null;
}

/**
 * Returns the stored context for (coach, student), or null if none / expired.
 * Expired contexts are deleted as a side effect.
 */
export async function getContext(
  coachId: string,
  studentPhone: string,
): Promise<ConversationContext | null> {
  const db = getFirestore();
  if (!db) {
    return null;
  }

  try {
    logger.info(
      `[CONTEXT FIRESTORE GET] coach=${coachId} phone=${maskPhone(studentPhone)}`,
    );
    const ref = db.collection(COLLECTION).doc(docIdFor(coachId, studentPhone));
    const snap = await ref.get();

    if (!snap.exists) {
      return null;
    }

    const data = snap.data() as ConversationContext;

    if (isExpired(data.expiresAt)) {
      logger.info(
        `[CONTEXT EXPIRED] coach=${coachId} phone=${maskPhone(studentPhone)}`,
      );
      await ref.delete();
      return null;
    }

    return data;
  } catch (error) {
    logger.error('[CONTEXT FIRESTORE GET] failed.', error);
    return null;
  }
}

/**
 * Creates or merges a (coach, student) context with the given partial fields.
 * Refreshes `updatedAt` and pushes the 30-minute `expiresAt` window forward.
 */
export async function updateContext(
  coachId: string,
  studentPhone: string,
  partialContext: Partial<
    Omit<
      ConversationContext,
      'coachId' | 'studentPhone' | 'updatedAt' | 'expiresAt'
    >
  >,
): Promise<ConversationContext | null> {
  const db = getFirestore();
  if (!db) {
    return null;
  }

  try {
    const existing = await readRaw(coachId, studentPhone);
    const now = DateTime.utc();

    const updated: ConversationContext = {
      coachId,
      studentPhone,
      lastIntent: existing?.lastIntent ?? '',
      lastSuggestedSlot: existing?.lastSuggestedSlot ?? null,
      lastBooking: existing?.lastBooking ?? null,
      language: existing?.language ?? 'en',
      ...partialContext,
      updatedAt: now.toISO() ?? new Date().toISOString(),
      expiresAt:
        now.plus({ minutes: TTL_MINUTES }).toISO() ?? new Date().toISOString(),
    };

    await db
      .collection(COLLECTION)
      .doc(docIdFor(coachId, studentPhone))
      .set(updated);
    logger.info(
      `[CONTEXT FIRESTORE SAVED] coach=${coachId} phone=${maskPhone(studentPhone)}`,
    );
    return updated;
  } catch (error) {
    logger.error('[CONTEXT FIRESTORE SAVED] failed.', error);
    return null;
  }
}

/**
 * Clears only the remembered suggested slot (e.g. after a successful booking),
 * keeping the rest of the context and refreshing the TTL.
 */
export async function clearLastSuggestedSlot(
  coachId: string,
  studentPhone: string,
): Promise<void> {
  const db = getFirestore();
  if (!db) {
    return;
  }

  try {
    const existing = await readRaw(coachId, studentPhone);
    if (!existing) {
      return;
    }

    const now = DateTime.utc();
    const updated: ConversationContext = {
      ...existing,
      coachId,
      studentPhone,
      lastSuggestedSlot: null,
      updatedAt: now.toISO() ?? new Date().toISOString(),
      expiresAt:
        now.plus({ minutes: TTL_MINUTES }).toISO() ?? new Date().toISOString(),
    };

    await db
      .collection(COLLECTION)
      .doc(docIdFor(coachId, studentPhone))
      .set(updated);
    logger.info(
      `[CONTEXT FIRESTORE CLEARED] coach=${coachId} phone=${maskPhone(studentPhone)}`,
    );
  } catch (error) {
    logger.error('[CONTEXT FIRESTORE CLEARED] failed.', error);
  }
}

/**
 * Deletes all expired conversation contexts (occasional cleanup job).
 * Returns the number of documents deleted.
 */
export async function deleteExpiredContexts(): Promise<number> {
  const db = getFirestore();
  if (!db) {
    return 0;
  }

  try {
    const nowIso = DateTime.utc().toISO() ?? new Date().toISOString();
    const snap = await db
      .collection(COLLECTION)
      .where('expiresAt', '<=', nowIso)
      .get();

    if (snap.empty) {
      return 0;
    }

    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    logger.info(`[CONTEXT FIRESTORE CLEARED] expired count=${snap.size}`);
    return snap.size;
  } catch (error) {
    logger.error('[CONTEXT FIRESTORE CLEARED] expired cleanup failed.', error);
    return 0;
  }
}
