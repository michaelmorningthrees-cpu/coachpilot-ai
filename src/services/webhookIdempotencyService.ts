/**
 * Webhook idempotency / duplicate protection.
 *
 * Meta may deliver the same webhook more than once (retries, at-least-once
 * delivery). We record each processed message in the `processed_webhook_messages`
 * collection so repeated deliveries are skipped.
 *
 * Document id:
 *   - the WhatsApp message id when available (message.id), otherwise
 *   - a SHA-256 hash of `from + timestamp + text` (prefixed "hash_").
 *
 * Records expire after 24 hours. Degrades gracefully: when Firestore is not
 * configured, isDuplicateMessage returns false and marking is a no-op, so local
 * curl testing keeps working.
 */

import crypto from 'crypto';
import { DateTime } from 'luxon';
import { logger, maskPhone } from './logger';
import { getFirestore } from '../config/firebaseAdmin';

const COLLECTION = 'processed_webhook_messages';
const TTL_HOURS = 24;

export interface ProcessedMessageRecord {
  messageId: string;
  fromMasked: string;
  receivedAt: string;
  expiresAt: string;
}

/**
 * Builds a stable, Firestore-safe document id for a message, scoped to a coach.
 * Uses `${coachId}_${messageId}` when the Meta message id is present, else a
 * hash of coachId+from+timestamp+text (so different coaches never collide).
 */
function resolveDocId(
  coachId: string,
  messageId: string | undefined,
  from: string,
  timestamp: string | undefined,
  text: string | undefined,
): string {
  if (messageId) {
    return `${coachId}_${messageId}`;
  }
  const hash = crypto
    .createHash('sha256')
    .update(`${coachId}|${from}|${timestamp ?? ''}|${text ?? ''}`)
    .digest('hex');
  return `${coachId}_hash_${hash}`;
}

function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) {
    return false;
  }
  const expiry = DateTime.fromISO(expiresAt);
  return expiry.isValid && expiry.toMillis() <= Date.now();
}

/**
 * Returns true if this message was already processed (and not expired).
 * Returns false when Firestore is unavailable so processing can proceed.
 */
export async function isDuplicateMessage(
  coachId: string,
  messageId: string | undefined,
  from: string,
  timestamp: string | undefined,
  text: string | undefined,
): Promise<boolean> {
  const docId = resolveDocId(coachId, messageId, from, timestamp, text);
  logger.info(
    `[IDEMPOTENCY CHECK] id=${docId} from=${maskPhone(from)}`,
  );

  const db = getFirestore();
  if (!db) {
    return false;
  }

  try {
    const ref = db.collection(COLLECTION).doc(docId);
    const snap = await ref.get();

    if (!snap.exists) {
      return false;
    }

    const data = snap.data() as ProcessedMessageRecord;
    if (isExpired(data.expiresAt)) {
      await ref.delete();
      return false;
    }

    return true;
  } catch (error) {
    logger.error('[IDEMPOTENCY CHECK] failed.', error);
    return false;
  }
}

/**
 * Records that a message has been accepted for processing, with a 24h TTL.
 * No-op when Firestore is unavailable.
 */
export async function markMessageProcessed(
  coachId: string,
  messageId: string | undefined,
  from: string,
  timestamp: string | undefined,
  text: string | undefined,
): Promise<void> {
  const db = getFirestore();
  if (!db) {
    return;
  }

  const docId = resolveDocId(coachId, messageId, from, timestamp, text);

  try {
    const now = DateTime.utc();
    const record: ProcessedMessageRecord = {
      messageId: docId,
      fromMasked: maskPhone(from),
      receivedAt: now.toISO() ?? new Date().toISOString(),
      expiresAt:
        now.plus({ hours: TTL_HOURS }).toISO() ?? new Date().toISOString(),
    };

    await db.collection(COLLECTION).doc(docId).set(record);
    logger.info(`[MESSAGE MARKED PROCESSED] id=${docId}`);
  } catch (error) {
    logger.error('[MESSAGE MARKED PROCESSED] failed.', error);
  }
}
