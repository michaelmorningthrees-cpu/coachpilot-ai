/**
 * Lightweight Google Calendar FreeBusy helper.
 *
 * Uses a service account (JWT) to query a single coach calendar's FreeBusy
 * status. MVP scope: read-only availability checks, one calendar, no bookings.
 *
 * Environment variables:
 *   - GOOGLE_CLIENT_EMAIL
 *   - GOOGLE_PRIVATE_KEY   (escaped "\n" sequences are restored at runtime)
 *   - GOOGLE_CALENDAR_ID
 */

import { google, calendar_v3 } from 'googleapis';

const FREEBUSY_SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

interface CalendarConfig {
  clientEmail: string;
  privateKey: string;
  calendarId: string;
}

export interface AvailabilityResult {
  available: boolean;
  busy: calendar_v3.Schema$TimePeriod[];
}

/**
 * Reads and validates the required environment variables, throwing a clear
 * error listing exactly what is missing.
 */
function getConfig(): CalendarConfig {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.GOOGLE_PRIVATE_KEY;
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  const missing: string[] = [];
  if (!clientEmail) missing.push('GOOGLE_CLIENT_EMAIL');
  if (!rawPrivateKey) missing.push('GOOGLE_PRIVATE_KEY');
  if (!calendarId) missing.push('GOOGLE_CALENDAR_ID');

  if (missing.length > 0 || !clientEmail || !rawPrivateKey || !calendarId) {
    throw new Error(
      `Missing Google Calendar env variable(s): ${missing.join(', ')}.`,
    );
  }

  return {
    clientEmail,
    // .env stores newlines as the literal characters "\n"; restore them so the
    // JWT key parses correctly and the connection does not fail.
    privateKey: rawPrivateKey.replace(/\\n/g, '\n'),
    calendarId,
  };
}

let cachedClient: calendar_v3.Calendar | null = null;

function getCalendar(config: CalendarConfig): calendar_v3.Calendar {
  if (cachedClient) {
    return cachedClient;
  }

  const auth = new google.auth.JWT({
    email: config.clientEmail,
    key: config.privateKey,
    scopes: FREEBUSY_SCOPES,
  });

  cachedClient = google.calendar({ version: 'v3', auth });
  return cachedClient;
}

/**
 * Runs a FreeBusy query for [startTimeIso, endTimeIso] and returns the raw
 * busy intervals reported by Google. ISO 8601 strings are expected,
 * e.g. "2026-06-30T15:00:00+08:00".
 */
async function queryFreeBusy(
  startTimeIso: string,
  endTimeIso: string,
): Promise<calendar_v3.Schema$TimePeriod[]> {
  const config = getConfig();
  const calendar = getCalendar(config);

  console.log(
    `[CALENDAR REQUEST] FreeBusy query for ${config.calendarId} between ${startTimeIso} and ${endTimeIso}`,
  );

  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: startTimeIso,
      timeMax: endTimeIso,
      items: [{ id: config.calendarId }],
    },
  });

  const busy = response.data.calendars?.[config.calendarId]?.busy ?? [];

  // Print the raw busy data for debugging.
  console.log('[CALENDAR RESPONSE] Raw busy data:', JSON.stringify(busy));

  return busy;
}

/**
 * Returns `true` when the given time slot is completely free (no busy
 * intervals), or `false` when it is busy ("不方便").
 *
 * On any error the slot is treated as NOT free (returns `false`) so we never
 * accidentally suggest a slot we could not verify.
 */
export async function checkCalendarFreeBusy(
  startTimeIso: string,
  endTimeIso: string,
): Promise<boolean> {
  try {
    const busy = await queryFreeBusy(startTimeIso, endTimeIso);
    return busy.length === 0;
  } catch (error) {
    console.error('[CALENDAR ERROR] FreeBusy check failed:', error);
    return false;
  }
}

/**
 * Same FreeBusy lookup, but returns a structured result including the raw busy
 * intervals: `{ available, busy }`. `available` is true when busy is empty.
 *
 * On any error returns `{ available: false, busy: [] }`.
 */
export async function checkAvailability(
  startISO: string,
  endISO: string,
): Promise<AvailabilityResult> {
  try {
    const busy = await queryFreeBusy(startISO, endISO);
    return { available: busy.length === 0, busy };
  } catch (error) {
    console.error('[CALENDAR ERROR] Availability check failed:', error);
    return { available: false, busy: [] };
  }
}
