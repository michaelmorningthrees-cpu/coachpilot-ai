/**
 * End-to-end multi-coach isolation test (Firestore-backed).
 *
 * Seeds the default coach, creates a temporary second coach, then verifies:
 *   - each WhatsApp phoneNumberId resolves to a distinct coach
 *   - conversation context is isolated per (coachId, studentPhone)
 *   - idempotency keys are scoped by coachId (same messageId, two coaches)
 *
 * Cleans up the temporary coach and test contexts afterwards.
 *
 * Requires Firebase + coach env vars. Run:  npm run test:multicoach
 */

import 'dotenv/config';

import { getFirestore } from '../config/firebaseAdmin';
import { seedDefaultCoach } from './seedDefaultCoach';
import {
  getCoachByWhatsAppPhoneNumberId,
} from '../services/coachResolverService';
import {
  updateContext,
  getContext,
} from '../services/conversationContextService';
import {
  isDuplicateMessage,
  markMessageProcessed,
} from '../services/webhookIdempotencyService';
import { Coach } from '../types/coach';

const TEST_COACH_ID = 'coach_test_2';
const TEST_PHONE_NUMBER_ID = '999000111222333';
const STUDENT_PHONE = '85299990000';

let failures = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${label}`);
  }
}

function buildTestCoach(now: string): Coach {
  return {
    coachId: TEST_COACH_ID,
    name: 'Test Coach 2',
    email: 'test2@example.com',
    sport: 'Tennis',
    timezone: 'Asia/Hong_Kong',
    language: 'en',
    status: 'active',
    workingHours: { mon: [{ start: '09:00', end: '17:00' }] },
    faq: {},
    pricing: {},
    calendar: {
      provider: 'google',
      calendarId: 'test2-calendar@example.com',
      serviceAccountMode: true,
    },
    whatsapp: {
      phoneNumberId: TEST_PHONE_NUMBER_ID,
      accessToken: 'test2-token',
    },
    createdAt: now,
    updatedAt: now,
  };
}

async function main(): Promise<void> {
  console.log('[TEST] Multi-coach isolation\n');

  const db = getFirestore();
  if (!db) {
    console.error('❌ Firestore is not configured. Set FIREBASE_* env vars.');
    process.exit(1);
  }

  // Setup: default coach + temporary second coach.
  const coach1 = await seedDefaultCoach();
  const now = new Date().toISOString();
  await db.collection('coaches').doc(TEST_COACH_ID).set(buildTestCoach(now));

  try {
    console.log('[TEST] Coach routing by phoneNumberId');
    const resolved1 = await getCoachByWhatsAppPhoneNumberId(
      coach1.whatsapp.phoneNumberId,
    );
    const resolved2 = await getCoachByWhatsAppPhoneNumberId(TEST_PHONE_NUMBER_ID);
    check('coach 1 resolved', resolved1?.coachId === coach1.coachId);
    check('coach 2 resolved', resolved2?.coachId === TEST_COACH_ID);
    check('coaches are distinct', resolved1?.coachId !== resolved2?.coachId);
    check('coach 2 uses its own calendarId', resolved2?.calendar.calendarId === 'test2-calendar@example.com');
    check('coach 2 uses its own WhatsApp token', resolved2?.whatsapp.accessToken === 'test2-token');

    console.log('\n[TEST] Context isolation (same student, two coaches)');
    await updateContext(coach1.coachId, STUDENT_PHONE, {
      lastIntent: 'check_availability',
      lastSuggestedSlot: {
        startISO: '2026-07-05T19:00:00+08:00',
        endISO: '2026-07-05T20:00:00+08:00',
        displayTextEn: 'Sunday 7–8pm',
        displayTextZh: '星期日晚上7–8點',
      },
      language: 'en',
    });
    await updateContext(TEST_COACH_ID, STUDENT_PHONE, {
      lastIntent: 'check_availability',
      lastSuggestedSlot: {
        startISO: '2026-07-06T10:00:00+08:00',
        endISO: '2026-07-06T11:00:00+08:00',
        displayTextEn: 'Monday 10–11am',
        displayTextZh: '星期一上午10–11點',
      },
      language: 'en',
    });

    const ctx1 = await getContext(coach1.coachId, STUDENT_PHONE);
    const ctx2 = await getContext(TEST_COACH_ID, STUDENT_PHONE);
    check('coach 1 context kept its own slot', ctx1?.lastSuggestedSlot?.startISO === '2026-07-05T19:00:00+08:00');
    check('coach 2 context kept its own slot', ctx2?.lastSuggestedSlot?.startISO === '2026-07-06T10:00:00+08:00');
    check('contexts did not bleed across coaches', ctx1?.lastSuggestedSlot?.startISO !== ctx2?.lastSuggestedSlot?.startISO);

    console.log('\n[TEST] Idempotency scoped by coachId');
    const sharedMessageId = `wamid.test.${Date.now()}`;
    const dup1Before = await isDuplicateMessage(coach1.coachId, sharedMessageId, STUDENT_PHONE, '1', 'hi');
    await markMessageProcessed(coach1.coachId, sharedMessageId, STUDENT_PHONE, '1', 'hi');
    const dup1After = await isDuplicateMessage(coach1.coachId, sharedMessageId, STUDENT_PHONE, '1', 'hi');
    const dup2 = await isDuplicateMessage(TEST_COACH_ID, sharedMessageId, STUDENT_PHONE, '1', 'hi');
    check('first delivery (coach 1) is not a duplicate', dup1Before === false);
    check('second delivery (coach 1) is a duplicate', dup1After === true);
    check('same messageId for coach 2 is NOT a duplicate', dup2 === false);

    // Cleanup processed messages we created.
    await db.collection('processed_webhook_messages').doc(`${coach1.coachId}_${sharedMessageId}`).delete();
    await db.collection('processed_webhook_messages').doc(`${TEST_COACH_ID}_${sharedMessageId}`).delete().catch(() => undefined);
  } finally {
    // Cleanup temporary coach + test contexts.
    await db.collection('coaches').doc(TEST_COACH_ID).delete();
    await db.collection('conversation_contexts').doc(`${coach1.coachId}_${STUDENT_PHONE}`).delete().catch(() => undefined);
    await db.collection('conversation_contexts').doc(`${TEST_COACH_ID}_${STUDENT_PHONE}`).delete().catch(() => undefined);
  }

  console.log('');
  if (failures === 0) {
    console.log('[TEST] ✅ Multi-coach isolation checks passed.');
    process.exit(0);
  } else {
    console.error(`[TEST] ❌ ${failures} check(s) failed.`);
    process.exit(1);
  }
}

void main();
