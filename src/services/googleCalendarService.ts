/**
 * Google Calendar service for CoachPilot AI (Step 3).
 *
 * Provides two operations driven by the Step 2 intent parser:
 *   - checkAvailability(): FreeBusy lookup + free 1-hour slot generation
 *   - createBooking(): creates an event, strictly preventing overlaps
 *
 * MVP simplifications: single coach calendar, fixed 1-hour sessions,
 * timezone-safe handling via Luxon.
 */

import { DateTime } from 'luxon';
import { calendar_v3 } from 'googleapis';
import { logger } from './logger';
import {
  getCalendarClient,
  getCalendarId,
  DEFAULT_TIMEZONE,
} from '../config/googleAuth';
import { buildOAuthCalendarClient } from '../config/googleOAuth';
import { resolveWindow } from '../utils/dateParser';
import { Coach } from '../types/coach';

const SESSION_MINUTES = 60;
const DEFAULT_EVENT_TITLE = 'Coaching Session';

/** Maps a coach's sport to a friendly calendar event title. */
const SPORT_EVENT_TITLES: Record<string, string> = {
  basketball: 'Basketball Training',
  badminton: 'Badminton Training',
  tennis: 'Tennis Training',
  fitness: 'Fitness Session',
  tutoring: 'Tutoring Session',
};

/**
 * Builds the calendar event title from the coach's sport, falling back to a
 * generic "Coaching Session" for unknown/empty sports.
 */
export function buildBookingEventTitle(coach: Pick<Coach, 'sport'>): string {
  const sport = coach.sport?.trim().toLowerCase() ?? '';
  return SPORT_EVENT_TITLES[sport] ?? DEFAULT_EVENT_TITLE;
}

/**
 * Returns the right Calendar client for a coach: a per-coach OAuth2 client when
 * the coach is in OAuth mode with tokens, otherwise the shared service account.
 */
export function getCalendarClientForCoach(coach: Coach): calendar_v3.Calendar {
  if (coach.calendar.serviceAccountMode === false && coach.calendar.refreshToken) {
    logger.info(`[CALENDAR] Using OAuth client for coach=${coach.coachId}.`);
    return buildOAuthCalendarClient(coach);
  }
  logger.info(`[CALENDAR] Using service account for coach=${coach.coachId}.`);
  return getCalendarClient();
}

export interface CalendarOption {
  id: string;
  summary: string;
  primary: boolean;
}

/**
 * Lists the calendars the coach can write to (OAuth mode only). Returns an
 * empty array if the coach is not OAuth-connected or the API call fails.
 */
export async function listCoachCalendars(coach: Coach): Promise<CalendarOption[]> {
  if (!(coach.calendar.serviceAccountMode === false && coach.calendar.refreshToken)) {
    return [];
  }
  try {
    const client = buildOAuthCalendarClient(coach);
    const res = await client.calendarList.list({ maxResults: 100, showHidden: false });
    return (res.data.items ?? [])
      .filter((c) => c.id && (c.accessRole === 'owner' || c.accessRole === 'writer'))
      .map((c) => ({
        id: c.id as string,
        summary: c.summaryOverride || c.summary || (c.id as string),
        primary: Boolean(c.primary),
      }));
  } catch (error) {
    logger.warn(`[CALENDAR] Failed to list calendars for coach=${coach.coachId}.`);
    return [];
  }
}

interface BusyInterval {
  start: DateTime;
  end: DateTime;
}

export interface CheckAvailabilityInput {
  date?: string;
  time?: string;
  calendarId?: string;
}

export interface CheckAvailabilityResult {
  available: boolean;
  /** Free 1-hour slot start times as ISO datetime strings. */
  slots: string[];
}

export interface FreeBusyAvailability {
  available: boolean;
  busy: unknown[];
}

export interface CreateBookingInput {
  date?: string;
  time?: string;
  durationMinutes?: number;
  studentName?: string;
  studentWhatsApp?: string;
  calendarId?: string;
  eventTitle?: string;
}

export type CreateBookingResult =
  | {
      success: true;
      eventId: string;
      start: string;
      end: string;
    }
  | {
      success: false;
      reason: string;
    };

export interface BookingResult {
  success: boolean;
  eventId?: string;
  reason?: string;
}

/**
 * Queries the FreeBusy API for busy intervals within [timeMin, timeMax].
 */
async function getBusyIntervals(
  client: calendar_v3.Calendar,
  calendarId: string,
  timeMin: DateTime,
  timeMax: DateTime,
): Promise<BusyInterval[]> {
  const response = await client.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISO() ?? undefined,
      timeMax: timeMax.toISO() ?? undefined,
      timeZone: DEFAULT_TIMEZONE,
      items: [{ id: calendarId }],
    },
  });

  const busy = response.data.calendars?.[calendarId]?.busy ?? [];
  return busy
    .filter((b): b is { start: string; end: string } =>
      Boolean(b.start && b.end),
    )
    .map((b) => ({
      start: DateTime.fromISO(b.start, { zone: DEFAULT_TIMEZONE }),
      end: DateTime.fromISO(b.end, { zone: DEFAULT_TIMEZONE }),
    }));
}

/**
 * True when [start, end) overlaps any busy interval.
 */
function overlapsBusy(
  start: DateTime,
  end: DateTime,
  busy: BusyInterval[],
): boolean {
  return busy.some(
    (interval) => start < interval.end && end > interval.start,
  );
}

/**
 * Direct FreeBusy availability check for an explicit ISO datetime range.
 *
 * `available` is true when Google reports no busy intervals in [startISO, endISO].
 * Never throws — on error it returns `{ available: false, busy: [] }`.
 */
async function checkFreeBusyRange(
  startISO: string,
  endISO: string,
  calendarIdArg?: string,
  clientArg?: calendar_v3.Calendar,
): Promise<FreeBusyAvailability> {
  const calendarId = calendarIdArg ?? getCalendarId();
  logger.info(
    `[FREEBUSY] calendarId=${calendarId} start=${startISO} end=${endISO}`,
  );

  try {
    const client = clientArg ?? getCalendarClient();
    const response = await client.freebusy.query({
      requestBody: {
        timeMin: startISO,
        timeMax: endISO,
        timeZone: DEFAULT_TIMEZONE,
        items: [{ id: calendarId }],
      },
    });

    const busy = response.data.calendars?.[calendarId]?.busy ?? [];
    logger.info(`[FREEBUSY] busy=${JSON.stringify(busy)}`);
    return { available: busy.length === 0, busy };
  } catch (error) {
    logger.error('checkAvailability (FreeBusy range) failed.', error);
    return { available: false, busy: [] };
  }
}

/**
 * Checks coach availability and returns free 1-hour slots within the window
 * implied by the (fuzzy) date/time from the AI intent.
 *
 * Never throws — on error it returns `{ available: false, slots: [] }`.
 */
async function findAvailableSlots(
  input: CheckAvailabilityInput,
): Promise<CheckAvailabilityResult> {
  try {
    const calendarId = input.calendarId ?? getCalendarId();
    const client = getCalendarClient();
    const now = DateTime.now().setZone(DEFAULT_TIMEZONE);
    const window = resolveWindow(input.date, input.time, DEFAULT_TIMEZONE, now);

    // Never offer slots in the past.
    const windowStart = window.start < now ? now.startOf('hour') : window.start;
    if (windowStart >= window.end) {
      logger.info('Availability window is empty or fully in the past.');
      return { available: false, slots: [] };
    }

    const busy = await getBusyIntervals(
      client,
      calendarId,
      windowStart,
      window.end,
    );

    const slots: string[] = [];
    let cursor = windowStart;
    while (cursor.plus({ minutes: SESSION_MINUTES }) <= window.end) {
      const slotEnd = cursor.plus({ minutes: SESSION_MINUTES });
      if (cursor >= now && !overlapsBusy(cursor, slotEnd, busy)) {
        const iso = cursor.toISO({ suppressMilliseconds: true });
        if (iso) {
          slots.push(iso);
        }
      }
      cursor = slotEnd;
    }

    logger.info(
      `Availability check: ${slots.length} free slot(s) found for calendar ${calendarId}.`,
    );
    return { available: slots.length > 0, slots };
  } catch (error) {
    logger.error('findAvailableSlots failed.', error);
    return { available: false, slots: [] };
  }
}

/**
 * Availability check with two supported call styles:
 *   1. checkAvailability({ date, time }) → fuzzy intent window + free 1-hour slots
 *      (used by the webhook flow; returns `{ available, slots }`).
 *   2. checkAvailability(startISO, endISO) → direct FreeBusy range check
 *      (returns `{ available, busy }`).
 */
export function checkAvailability(
  input: CheckAvailabilityInput,
): Promise<CheckAvailabilityResult>;
export function checkAvailability(
  startISO: string,
  endISO: string,
  calendarId?: string,
  client?: calendar_v3.Calendar,
): Promise<FreeBusyAvailability>;
export function checkAvailability(
  arg1: CheckAvailabilityInput | string,
  arg2?: string,
  arg3?: string,
  arg4?: calendar_v3.Calendar,
): Promise<CheckAvailabilityResult | FreeBusyAvailability> {
  if (typeof arg1 === 'string' && typeof arg2 === 'string') {
    return checkFreeBusyRange(arg1, arg2, arg3, arg4);
  }
  return findAvailableSlots(arg1 as CheckAvailabilityInput);
}

/**
 * Creates a booking for an explicit ISO datetime range.
 *
 * Re-checks FreeBusy first; if the slot is busy, no event is created. On
 * success creates a "Basketball Training" event tagged with the student phone.
 * Never throws — failures are returned as `{ success: false, reason }`.
 */
async function createBookingByRange(
  startISO: string,
  endISO: string,
  studentPhone: string,
  calendarIdArg?: string,
  eventTitle: string = DEFAULT_EVENT_TITLE,
  clientArg?: calendar_v3.Calendar,
): Promise<BookingResult> {
  const calendarId = calendarIdArg ?? getCalendarId();

  try {
    // Double-booking prevention: verify the slot is still free.
    const availability = await checkAvailability(
      startISO,
      endISO,
      calendarId,
      clientArg,
    );
    if (!availability.available) {
      logger.warn('Booking rejected: slot is busy.');
      return { success: false, reason: 'That time slot is already booked.' };
    }

    const client = clientArg ?? getCalendarClient();
    const response = await client.events.insert({
      calendarId,
      requestBody: {
        summary: eventTitle,
        description: `Booked via CoachPilot AI. Student WhatsApp: ${studentPhone}`,
        start: { dateTime: startISO, timeZone: DEFAULT_TIMEZONE },
        end: { dateTime: endISO, timeZone: DEFAULT_TIMEZONE },
      },
    });

    const eventId = response.data.id ?? undefined;
    logger.info(`Booking created: ${eventId ?? 'unknown'} (${startISO} → ${endISO}).`);
    return { success: true, eventId };
  } catch (error) {
    logger.error('createBooking (range) failed.', error);
    return { success: false, reason: 'Unexpected error while creating booking.' };
  }
}

/**
 * Creates a 1-hour (default) booking event, strictly preventing overlaps with
 * any existing busy interval. Requires an explicit start time from the intent.
 *
 * Never throws — failures are returned as `{ success: false, reason }`.
 */
async function createBookingFromInput(
  input: CreateBookingInput,
): Promise<CreateBookingResult> {
  try {
    const calendarId = input.calendarId ?? getCalendarId();
    const client = getCalendarClient();
    const now = DateTime.now().setZone(DEFAULT_TIMEZONE);
    const window = resolveWindow(input.date, input.time, DEFAULT_TIMEZONE, now);

    if (!window.explicit) {
      return {
        success: false,
        reason:
          'No specific start time was provided; cannot create a booking from a vague period.',
      };
    }

    const start = window.start;
    const duration = input.durationMinutes ?? SESSION_MINUTES;
    const end = start.plus({ minutes: duration });

    if (start < now) {
      return { success: false, reason: 'Requested start time is in the past.' };
    }

    // Strict double-booking prevention: re-check FreeBusy for the exact slot.
    const busy = await getBusyIntervals(client, calendarId, start, end);
    if (overlapsBusy(start, end, busy)) {
      logger.warn('Booking rejected due to overlap with an existing event.');
      return {
        success: false,
        reason: 'That time slot is already booked.',
      };
    }

    const descriptionLines = ['Booked via CoachPilot AI.'];
    if (input.studentName) {
      descriptionLines.push(`Student: ${input.studentName}`);
    }
    if (input.studentWhatsApp) {
      descriptionLines.push(`WhatsApp: ${input.studentWhatsApp}`);
    }

    const startIso = start.toISO({ suppressMilliseconds: true });
    const endIso = end.toISO({ suppressMilliseconds: true });
    if (!startIso || !endIso) {
      return { success: false, reason: 'Failed to compute event times.' };
    }

    const response = await client.events.insert({
      calendarId,
      requestBody: {
        summary: input.eventTitle ?? DEFAULT_EVENT_TITLE,
        description: descriptionLines.join('\n'),
        start: { dateTime: startIso, timeZone: DEFAULT_TIMEZONE },
        end: { dateTime: endIso, timeZone: DEFAULT_TIMEZONE },
      },
    });

    const eventId = response.data.id;
    if (!eventId) {
      return { success: false, reason: 'Calendar did not return an event ID.' };
    }

    logger.info(`Booking created: ${eventId} (${startIso} → ${endIso}).`);
    return { success: true, eventId, start: startIso, end: endIso };
  } catch (error) {
    logger.error('createBooking failed.', error);
    return { success: false, reason: 'Unexpected error while creating booking.' };
  }
}

/**
 * Creates a booking with two supported call styles:
 *   1. createBooking({ date, time, ... }) → fuzzy intent input
 *      (returns the detailed `CreateBookingResult`).
 *   2. createBooking(startISO, endISO, studentPhone) → explicit ISO range
 *      (re-checks availability first; returns `{ success, eventId, reason }`).
 */
export function createBooking(
  input: CreateBookingInput,
): Promise<CreateBookingResult>;
export function createBooking(
  startISO: string,
  endISO: string,
  studentPhone: string,
  calendarId?: string,
  eventTitle?: string,
  client?: calendar_v3.Calendar,
): Promise<BookingResult>;
export function createBooking(
  arg1: CreateBookingInput | string,
  arg2?: string,
  arg3?: string,
  arg4?: string,
  arg5?: string,
  arg6?: calendar_v3.Calendar,
): Promise<CreateBookingResult | BookingResult> {
  if (typeof arg1 === 'string' && typeof arg2 === 'string') {
    return createBookingByRange(arg1, arg2, arg3 ?? '', arg4, arg5, arg6);
  }
  return createBookingFromInput(arg1 as CreateBookingInput);
}
