/**
 * Standalone test for the webhook idempotency service.
 *
 * Exercises: first sight is not a duplicate → mark processed → second sight IS
 * a duplicate. Tests both the explicit-message-id path and the hash fallback.
 * Requires Firebase env vars.
 *
 * Run with:  npx ts-node src/scripts/testIdempotency.ts
 *       or:  npm run test:idempotency
 */

import dotenv from 'dotenv';
import {
  isDuplicateMessage,
  markMessageProcessed,
} from '../services/webhookIdempotencyService';
import { isFirestoreConfigured } from '../config/firebaseAdmin';

dotenv.config();

const TEST_COACH_ID = 'coach_test_idem';
const FROM = '85290000002';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✅ ${message}`);
}

async function runCase(
  label: string,
  messageId: string | undefined,
  timestamp: string | undefined,
  text: string | undefined,
): Promise<void> {
  console.log(`\n[TEST] ${label}`);

  const firstSeen = await isDuplicateMessage(
    TEST_COACH_ID,
    messageId,
    FROM,
    timestamp,
    text,
  );
  assert(firstSeen === false, 'first delivery is NOT a duplicate');

  await markMessageProcessed(TEST_COACH_ID, messageId, FROM, timestamp, text);

  const secondSeen = await isDuplicateMessage(
    TEST_COACH_ID,
    messageId,
    FROM,
    timestamp,
    text,
  );
  assert(secondSeen === true, 'second delivery IS a duplicate');
}

async function main(): Promise<void> {
  console.log('[TEST] Webhook idempotency');

  if (!isFirestoreConfigured()) {
    console.error(
      '[TEST] ⛔ Firebase is not configured. Set FIREBASE_PROJECT_ID, ' +
        'FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in .env.',
    );
    process.exit(1);
  }

  // Use unique values per run so reruns start clean.
  const unique = Date.now().toString();

  await runCase(
    '1) Explicit message id',
    `wamid.TEST_${unique}`,
    '1700000000',
    'Sunday 7pm available?',
  );

  await runCase(
    '2) Hash fallback (no message id)',
    undefined,
    unique,
    'ok book it',
  );

  console.log('\n[TEST] ✅ All idempotency checks passed.');
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(
    '[ERROR]',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
