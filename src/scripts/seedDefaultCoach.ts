/**
 * Seeds (creates or updates) the first coach document in Firestore from the
 * current .env values. This turns the existing single-coach setup into the
 * first record in the multi-coach `coaches` collection.
 *
 * Run:  npm run seed:coach
 *
 * Required env: DEFAULT_COACH_ID, GOOGLE_CALENDAR_ID, WHATSAPP_PHONE_NUMBER_ID,
 *               WHATSAPP_TOKEN.
 * Optional env: COACH_NAME, COACH_EMAIL, COACH_SPORT, COACH_TIMEZONE,
 *               COACH_LANGUAGE, WORKING_HOURS_JSON.
 */

import 'dotenv/config';

import { getFirestore } from '../config/firebaseAdmin';
import { parseWorkingHours } from '../services/coachConfigService';
import { Coach } from '../types/coach';

const COLLECTION = 'coaches';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function buildCoachFromEnv(now: string): Coach {
  const coachId = requireEnv('DEFAULT_COACH_ID');
  const language = (process.env.COACH_LANGUAGE === 'zh' ? 'zh' : 'en') as
    | 'zh'
    | 'en';

  return {
    coachId,
    name: process.env.COACH_NAME ?? 'Default Coach',
    email: process.env.COACH_EMAIL ?? '',
    sport: process.env.COACH_SPORT ?? 'Basketball',
    timezone: process.env.COACH_TIMEZONE ?? 'Asia/Hong_Kong',
    language,
    status: 'active',
    workingHours: parseWorkingHours(process.env.WORKING_HOURS_JSON),
    faq: {},
    pricing: {},
    calendar: {
      provider: 'google',
      calendarId: requireEnv('GOOGLE_CALENDAR_ID'),
      serviceAccountMode: true,
    },
    whatsapp: {
      phoneNumberId: requireEnv('WHATSAPP_PHONE_NUMBER_ID'),
      accessToken: requireEnv('WHATSAPP_TOKEN'),
    },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Creates or updates the default coach document. Preserves the original
 * createdAt when the document already exists. Returns the written coach.
 */
export async function seedDefaultCoach(): Promise<Coach> {
  const db = getFirestore();
  if (!db) {
    throw new Error(
      'Firestore is not configured. Set FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.',
    );
  }

  const now = new Date().toISOString();
  const coach = buildCoachFromEnv(now);
  const ref = db.collection(COLLECTION).doc(coach.coachId);

  const existing = await ref.get();
  if (existing.exists) {
    const prev = existing.data() as Coach;
    coach.createdAt = prev.createdAt ?? now;
  }

  await ref.set(coach, { merge: true });
  return coach;
}

async function main(): Promise<void> {
  try {
    const coach = await seedDefaultCoach();
    console.log('✅ Seeded coach:');
    console.log(`   coachId:        ${coach.coachId}`);
    console.log(`   name:           ${coach.name}`);
    console.log(`   sport:          ${coach.sport}`);
    console.log(`   timezone:       ${coach.timezone}`);
    console.log(`   calendarId:     ${coach.calendar.calendarId}`);
    console.log(`   wa phoneNumber: ${coach.whatsapp.phoneNumberId}`);
    console.log(
      `   workingHours days: ${Object.keys(coach.workingHours).join(', ')}`,
    );
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to seed default coach.');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
