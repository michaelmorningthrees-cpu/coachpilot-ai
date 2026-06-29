/**
 * Coach data model for the multi-coach (Phase 2) backend.
 *
 * Stored in the Firestore `coaches` collection (document id = coachId).
 * A single WhatsApp Business phone number (phoneNumberId) maps to exactly one
 * coach, which is how incoming webhooks are routed to the right coach config.
 */

export interface WorkingInterval {
  start: string; // "HH:mm"
  end: string; // "HH:mm"
}

/** Day keys: sun, mon, tue, wed, thu, fri, sat. An empty array = closed. */
export type WorkingHours = Record<string, WorkingInterval[]>;

export type CoachStatus = 'active' | 'inactive' | 'setup_pending';

export interface CoachCalendarConfig {
  provider: 'google';
  calendarId: string;
  accessToken?: string;
  refreshToken?: string;
  /** OAuth access-token expiry, epoch ms (from Google token response). */
  expiryDate?: number;
  /** When true, access is via the shared service account (no per-coach OAuth). */
  serviceAccountMode: boolean;
}

export interface CoachWhatsAppConfig {
  phoneNumberId: string;
  wabaId?: string;
  accessToken: string;
  displayPhoneNumber?: string;
  /** ISO timestamp of the last successful WhatsApp connection. */
  connectedAt?: string;
}

/** Free-form FAQ answers, keyed by topic (e.g. venue, duration). */
export interface CoachFaq {
  venue?: string;
  duration?: string;
  [key: string]: string | undefined;
}

export interface CoachPricing {
  /** Human-readable pricing answer sent to students. */
  text?: string;
  perSession?: number;
  currency?: string;
}

export interface Coach {
  coachId: string;
  name: string;
  email: string;
  sport: string;
  timezone: string;
  language: 'zh' | 'en';
  status: CoachStatus;
  workingHours: WorkingHours;
  faq?: CoachFaq;
  pricing?: CoachPricing;
  calendar: CoachCalendarConfig;
  whatsapp: CoachWhatsAppConfig;
  /** Firebase Auth uid linking this coach to a login account. */
  authUid?: string;
  /** True until the coach changes the admin-issued temporary password. */
  mustChangePassword?: boolean;
  createdAt: string;
  updatedAt: string;
}
