/**
 * Verifies coach resolution by id and by WhatsApp phone number id, plus the
 * webhook resolver fallback to DEFAULT_COACH_ID.
 *
 * Seeds the default coach first so the test is self-contained.
 *
 * Requires Firebase + coach env vars. Run:  npm run test:resolver:coach
 */

import 'dotenv/config';

import { seedDefaultCoach } from './seedDefaultCoach';
import {
  getCoachById,
  getCoachByWhatsAppPhoneNumberId,
  resolveCoachForWebhook,
} from '../services/coachResolverService';

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
  console.log('[TEST] Coach resolver\n');

  const seeded = await seedDefaultCoach();
  const { coachId } = seeded;
  const phoneNumberId = seeded.whatsapp.phoneNumberId;

  const byId = await getCoachById(coachId);
  check('getCoachById returns the coach', byId?.coachId === coachId);

  const byPhone = await getCoachByWhatsAppPhoneNumberId(phoneNumberId);
  check(
    'getCoachByWhatsAppPhoneNumberId returns the coach',
    byPhone?.coachId === coachId,
  );

  const missing = await getCoachByWhatsAppPhoneNumberId('000000000000000');
  check('unknown phoneNumberId resolves to null', missing === null);

  const viaPhone = await resolveCoachForWebhook(phoneNumberId);
  check('resolveCoachForWebhook(phoneNumberId) → coach', viaPhone?.coachId === coachId);

  const viaDefault = await resolveCoachForWebhook(undefined);
  check(
    'resolveCoachForWebhook(undefined) → DEFAULT_COACH_ID coach',
    viaDefault?.coachId === coachId,
  );

  // Confirm coach-specific values are present for the production flow.
  check('coach has calendarId', Boolean(byId?.calendar.calendarId));
  check('coach has whatsapp token', Boolean(byId?.whatsapp.accessToken));

  console.log('');
  if (failures === 0) {
    console.log('[TEST] ✅ Coach resolver checks passed.');
    process.exit(0);
  } else {
    console.error(`[TEST] ❌ ${failures} check(s) failed.`);
    process.exit(1);
  }
}

void main();
