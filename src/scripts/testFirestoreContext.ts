/**
 * Standalone test for the Firestore-backed conversation context service.
 *
 * Exercises: save → read → clear suggested slot → re-read.
 * Requires Firebase env vars (FIREBASE_PROJECT_ID / CLIENT_EMAIL / PRIVATE_KEY).
 *
 * Run with:  npx ts-node src/scripts/testFirestoreContext.ts
 *       or:  npm run test:context
 */

import dotenv from 'dotenv';
import {
  getContext,
  updateContext,
  clearLastSuggestedSlot,
  deleteExpiredContexts,
} from '../services/conversationContextService';
import { isFirestoreConfigured } from '../config/firebaseAdmin';

dotenv.config();

const TEST_COACH_ID = 'coach_test_ctx';
const TEST_PHONE = '85290000001';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✅ ${message}`);
}

async function main(): Promise<void> {
  console.log('[TEST] Firestore conversation context');

  if (!isFirestoreConfigured()) {
    console.error(
      '[TEST] ⛔ Firebase is not configured. Set FIREBASE_PROJECT_ID, ' +
        'FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in .env.',
    );
    process.exit(1);
  }

  console.log('\n[TEST] 1) Save context');
  const saved = await updateContext(TEST_COACH_ID, TEST_PHONE, {
    lastIntent: 'check_availability',
    language: 'en',
    lastSuggestedSlot: {
      startISO: '2026-06-28T19:00:00+08:00',
      endISO: '2026-06-28T20:00:00+08:00',
      displayTextEn: 'Sunday 7–8pm',
      displayTextZh: '星期日晚上7–8點',
    },
  });
  assert(saved !== null, 'updateContext returned a context');
  assert(saved?.expiresAt !== undefined, 'context has an expiresAt (TTL)');

  console.log('\n[TEST] 2) Read context');
  const read = await getContext(TEST_COACH_ID, TEST_PHONE);
  assert(read !== null, 'getContext returned the saved context');
  assert(
    read?.lastSuggestedSlot?.startISO === '2026-06-28T19:00:00+08:00',
    'lastSuggestedSlot persisted correctly',
  );
  assert(read?.language === 'en', 'language persisted correctly');

  console.log('\n[TEST] 3) Clear suggested slot');
  await clearLastSuggestedSlot(TEST_COACH_ID, TEST_PHONE);
  const afterClear = await getContext(TEST_COACH_ID, TEST_PHONE);
  assert(
    afterClear?.lastSuggestedSlot === null,
    'lastSuggestedSlot is null after clear',
  );
  assert(
    afterClear?.lastIntent === 'check_availability',
    'other fields preserved after clear',
  );

  console.log('\n[TEST] 4) Cleanup helper runs');
  const deleted = await deleteExpiredContexts();
  console.log(`  ℹ️  deleteExpiredContexts removed ${deleted} expired doc(s)`);

  console.log('\n[TEST] ✅ All conversation context checks passed.');
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(
    '[ERROR]',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
