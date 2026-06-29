/**
 * Verifies the seed script writes the default coach correctly.
 *
 * Requires Firebase env vars (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL /
 * FIREBASE_PRIVATE_KEY) and the coach env vars used by the seed script.
 *
 * Run:  npm run test:seed
 */

import 'dotenv/config';

import { seedDefaultCoach } from './seedDefaultCoach';
import { getCoachById } from '../services/coachResolverService';

let failures = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${label}`);
  }
}

async function main(): Promise<void> {
  console.log('[TEST] Seed default coach\n');

  const seeded = await seedDefaultCoach();
  console.log(`  Seeded coachId=${seeded.coachId}`);

  const readBack = await getCoachById(seeded.coachId);
  check('coach can be read back', readBack !== null);

  if (readBack) {
    check('coachId matches env', readBack.coachId === process.env.DEFAULT_COACH_ID);
    check(
      'calendarId matches env',
      readBack.calendar.calendarId === process.env.GOOGLE_CALENDAR_ID,
    );
    check(
      'whatsapp.phoneNumberId matches env',
      readBack.whatsapp.phoneNumberId === process.env.WHATSAPP_PHONE_NUMBER_ID,
    );
    check(
      'whatsapp.accessToken matches env',
      readBack.whatsapp.accessToken === process.env.WHATSAPP_TOKEN,
    );
    check('status is active', readBack.status === 'active');
    check('has at least one working-hours day', Object.keys(readBack.workingHours).length > 0);
  }

  console.log('');
  if (failures === 0) {
    console.log('[TEST] ✅ Seed checks passed.');
    process.exit(0);
  } else {
    console.error(`[TEST] ❌ ${failures} check(s) failed.`);
    process.exit(1);
  }
}

void main();
