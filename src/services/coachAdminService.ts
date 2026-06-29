/**
 * Admin/onboarding operations on the `coaches` collection.
 *
 * These are write-heavy helpers used by the dashboard (create coach, edit
 * profile, save WhatsApp config, flip status). Firestore stays the source of
 * truth; the resolver cache is invalidated after each write.
 */

import { getFirestore } from '../config/firebaseAdmin';
import { resetCoachCache } from './coachResolverService';
import { parseWorkingHours } from './coachConfigService';
import {
  Coach,
  CoachStatus,
  WorkingHours,
  CoachFaq,
  CoachPricing,
} from '../types/coach';

const COLLECTION = 'coaches';

export interface CreateCoachInput {
  coachId: string;
  name: string;
  email?: string;
  sport?: string;
  timezone?: string;
  language?: 'zh' | 'en';
  calendarId?: string;
  workingHoursJson?: string;
}

export interface UpdateCoachProfileInput {
  name?: string;
  email?: string;
  sport?: string;
  timezone?: string;
  language?: 'zh' | 'en';
  calendarId?: string;
  workingHours?: WorkingHours;
  faq?: CoachFaq;
  pricing?: CoachPricing;
}

export interface ManualWhatsAppInput {
  phoneNumberId: string;
  accessToken: string;
  displayPhoneNumber?: string;
  wabaId?: string;
}

function db() {
  const instance = getFirestore();
  if (!instance) {
    throw new Error('Firestore is not configured.');
  }
  return instance;
}

/** True when the coach has both a usable calendar and WhatsApp config. */
export function isCoachReady(coach: Coach): boolean {
  const calendarReady = Boolean(
    coach.calendar?.calendarId &&
      (coach.calendar.serviceAccountMode || coach.calendar.refreshToken),
  );
  const whatsappReady = Boolean(
    coach.whatsapp?.phoneNumberId && coach.whatsapp?.accessToken,
  );
  return calendarReady && whatsappReady;
}

export async function listCoaches(): Promise<Coach[]> {
  const snap = await db().collection(COLLECTION).get();
  return snap.docs
    .map((doc) => doc.data() as Coach)
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}

export async function createCoach(input: CreateCoachInput): Promise<Coach> {
  const ref = db().collection(COLLECTION).doc(input.coachId);
  const existing = await ref.get();
  if (existing.exists) {
    throw new Error(`Coach "${input.coachId}" already exists.`);
  }

  const now = new Date().toISOString();
  const coach: Coach = {
    coachId: input.coachId,
    name: input.name,
    email: input.email ?? '',
    sport: input.sport ?? 'Coaching',
    timezone: input.timezone ?? 'Asia/Hong_Kong',
    language: input.language ?? 'en',
    status: 'setup_pending',
    workingHours: parseWorkingHours(input.workingHoursJson),
    faq: {},
    pricing: {},
    calendar: {
      provider: 'google',
      calendarId: input.calendarId ?? '',
      // Defaults to service-account mode; flips to false when the coach
      // connects their own Google account via OAuth.
      serviceAccountMode: true,
    },
    whatsapp: {
      phoneNumberId: '',
      accessToken: '',
    },
    createdAt: now,
    updatedAt: now,
  };

  await ref.set(coach);
  resetCoachCache();
  return coach;
}

export async function updateCoachProfile(
  coachId: string,
  input: UpdateCoachProfileInput,
): Promise<void> {
  const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.name !== undefined) update.name = input.name;
  if (input.email !== undefined) update.email = input.email;
  if (input.sport !== undefined) update.sport = input.sport;
  if (input.timezone !== undefined) update.timezone = input.timezone;
  if (input.language !== undefined) update.language = input.language;
  if (input.calendarId !== undefined) {
    update['calendar.calendarId'] = input.calendarId;
  }
  if (input.workingHours !== undefined) update.workingHours = input.workingHours;
  if (input.faq !== undefined) update.faq = input.faq;
  if (input.pricing !== undefined) update.pricing = input.pricing;

  await db().collection(COLLECTION).doc(coachId).update(update);
  resetCoachCache();
}

/**
 * Links a Firebase Auth uid to a coach and (optionally) flags that the coach
 * must change their temporary password on first login.
 */
export async function linkCoachAuth(
  coachId: string,
  authUid: string,
  mustChangePassword: boolean,
): Promise<void> {
  await db()
    .collection(COLLECTION)
    .doc(coachId)
    .update({
      authUid,
      mustChangePassword,
      updatedAt: new Date().toISOString(),
    });
  resetCoachCache();
}

/** Persists the post-signup WhatsApp setup status (webhook/phone/token). */
export async function saveWhatsAppSetupStatus(
  coachId: string,
  status: {
    tokenValidated: boolean;
    webhookSubscribed: boolean;
    phoneRegistered: boolean;
    setupWarnings: string[];
    lastSetupCheckAt: string;
  },
): Promise<void> {
  await db()
    .collection(COLLECTION)
    .doc(coachId)
    .update({
      'whatsapp.tokenValidated': status.tokenValidated,
      'whatsapp.webhookSubscribed': status.webhookSubscribed,
      'whatsapp.phoneRegistered': status.phoneRegistered,
      'whatsapp.setupWarnings': status.setupWarnings,
      'whatsapp.lastSetupCheckAt': status.lastSetupCheckAt,
      updatedAt: new Date().toISOString(),
    });
  resetCoachCache();
}

/** Clears the force-change-password flag after a successful change. */
export async function clearMustChangePassword(coachId: string): Promise<void> {
  await db()
    .collection(COLLECTION)
    .doc(coachId)
    .update({ mustChangePassword: false, updatedAt: new Date().toISOString() });
  resetCoachCache();
}

export async function setCoachStatus(
  coachId: string,
  status: CoachStatus,
): Promise<void> {
  await db()
    .collection(COLLECTION)
    .doc(coachId)
    .update({ status, updatedAt: new Date().toISOString() });
  resetCoachCache();
}

/**
 * Saves WhatsApp config (manual entry or Embedded Signup result) and activates
 * the coach when both calendar and WhatsApp are ready.
 */
export async function saveCoachWhatsApp(
  coachId: string,
  input: ManualWhatsAppInput,
): Promise<void> {
  const ref = db().collection(COLLECTION).doc(coachId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new Error(`Coach "${coachId}" not found.`);
  }

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    'whatsapp.phoneNumberId': input.phoneNumberId,
    'whatsapp.accessToken': input.accessToken,
    'whatsapp.connectedAt': now,
    updatedAt: now,
  };
  if (input.displayPhoneNumber !== undefined) {
    update['whatsapp.displayPhoneNumber'] = input.displayPhoneNumber;
  }
  if (input.wabaId !== undefined) {
    update['whatsapp.wabaId'] = input.wabaId;
  }

  await ref.update(update);

  // Re-read to evaluate readiness and possibly activate.
  const updated = (await ref.get()).data() as Coach;
  if (updated.status !== 'active' && isCoachReady(updated)) {
    await ref.update({ status: 'active', updatedAt: new Date().toISOString() });
  }
  resetCoachCache();
}
