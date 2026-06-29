/**
 * Google Calendar authentication (service account / JWT).
 *
 * The coach must share their calendar with the service account email and grant
 * "Make changes to events" so we can read FreeBusy and create events.
 *
 * Credentials come from environment variables:
 *   - GOOGLE_CLIENT_EMAIL
 *   - GOOGLE_PRIVATE_KEY  (literal "\n" sequences are converted to newlines)
 *   - GOOGLE_CALENDAR_ID
 *   - GOOGLE_CALENDAR_TIMEZONE (optional, defaults to Asia/Hong_Kong)
 */

import { google, calendar_v3 } from 'googleapis';

const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar'];

export const DEFAULT_TIMEZONE =
  process.env.GOOGLE_CALENDAR_TIMEZONE ?? 'Asia/Hong_Kong';

/**
 * Returns the configured calendar ID, throwing if it is missing so callers
 * fail fast with a clear message instead of hitting a confusing API error.
 */
export function getCalendarId(): string {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) {
    throw new Error('GOOGLE_CALENDAR_ID is not set.');
  }
  return calendarId;
}

let cachedClient: calendar_v3.Calendar | null = null;

/**
 * Lazily builds and caches an authenticated Google Calendar client.
 * Lazy init keeps the module import side-effect free so the server can boot
 * (and earlier steps run) without Google credentials configured.
 */
export function getCalendarClient(): calendar_v3.Calendar {
  if (cachedClient) {
    return cachedClient;
  }

  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!clientEmail || !rawPrivateKey) {
    throw new Error(
      'Google credentials missing: set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY.',
    );
  }

  // .env stores newlines as the literal characters "\n"; restore them.
  const privateKey = rawPrivateKey.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: CALENDAR_SCOPES,
  });

  cachedClient = google.calendar({ version: 'v3', auth });
  return cachedClient;
}
