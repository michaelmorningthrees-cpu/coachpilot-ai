/**
 * Converts the fuzzy `date` / `time` strings produced by the Step 2 intent
 * parser (e.g. "Wednesday", "next Monday", "evening", "7pm", "8-9pm") into
 * concrete, timezone-aware datetime windows using Luxon.
 *
 * All calculations are anchored to "now" in the configured timezone, so the
 * results are timezone-safe regardless of the server's local clock.
 */

import { DateTime } from 'luxon';

export interface ResolvedWindow {
  /** Inclusive start of the search/booking window. */
  start: DateTime;
  /** Exclusive end of the window. */
  end: DateTime;
  /**
   * True when the user gave a specific start time (e.g. "7pm") rather than a
   * vague period (e.g. "evening"). Booking requires a specific start.
   */
  explicit: boolean;
}

const WEEKDAYS: Record<string, number> = {
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
  sunday: 7,
  sun: 7,
};

interface DayPeriod {
  startMinutes: number;
  endMinutes: number;
}

const DAY_PERIODS: Record<string, DayPeriod> = {
  morning: { startMinutes: 9 * 60, endMinutes: 12 * 60 },
  noon: { startMinutes: 12 * 60, endMinutes: 13 * 60 },
  afternoon: { startMinutes: 12 * 60, endMinutes: 17 * 60 },
  evening: { startMinutes: 18 * 60, endMinutes: 21 * 60 },
  night: { startMinutes: 19 * 60, endMinutes: 22 * 60 },
};

// Sensible coaching day when the user gives no time at all.
const DEFAULT_DAY: DayPeriod = { startMinutes: 9 * 60, endMinutes: 21 * 60 };

/**
 * Resolves a fuzzy date string to the start of the target day in `zone`.
 * Falls back to "today" when the string is missing or unrecognised.
 */
export function resolveDate(
  dateStr: string | undefined,
  zone: string,
  now: DateTime = DateTime.now().setZone(zone),
): DateTime {
  const base = now.setZone(zone).startOf('day');

  if (!dateStr) {
    return base;
  }

  const text = dateStr.trim().toLowerCase();

  if (text === 'today') {
    return base;
  }
  if (text === 'tomorrow') {
    return base.plus({ days: 1 });
  }
  if (text === 'day after tomorrow') {
    return base.plus({ days: 2 });
  }

  // Explicit ISO date, e.g. "2026-06-27".
  const isoMatch = text.match(/^\d{4}-\d{2}-\d{2}$/);
  if (isoMatch) {
    const parsed = DateTime.fromISO(text, { zone });
    if (parsed.isValid) {
      return parsed.startOf('day');
    }
  }

  // Weekday names, optionally prefixed with "next".
  const isNext = /\bnext\b/.test(text);
  const cleaned = text.replace(/\bnext\b/, '').trim();
  const weekday = WEEKDAYS[cleaned];
  if (weekday) {
    return nextWeekday(base, weekday, isNext);
  }

  return base;
}

/**
 * Returns the next occurrence of `targetWeekday` (1=Mon..7=Sun) on or after
 * `base`. When `forceNextWeek` is true, always skips to the following week.
 */
function nextWeekday(
  base: DateTime,
  targetWeekday: number,
  forceNextWeek: boolean,
): DateTime {
  let diff = (targetWeekday - base.weekday + 7) % 7;
  if (forceNextWeek) {
    diff = diff === 0 ? 7 : diff + 7;
  }
  return base.plus({ days: diff });
}

/**
 * Parses a clock token like "7pm", "7:30 pm", "19", or "19:00" into minutes
 * from midnight. `inheritMeridiem` supplies am/pm when the token omits it
 * (used for the first half of ranges such as "8-9pm").
 */
function parseClock(
  token: string,
  inheritMeridiem?: 'am' | 'pm',
): { minutes: number; meridiem?: 'am' | 'pm' } | null {
  const match = token
    .trim()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = (match[3] as 'am' | 'pm' | undefined) ?? inheritMeridiem;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  if (meridiem === 'pm' && hour < 12) {
    hour += 12;
  } else if (meridiem === 'am' && hour === 12) {
    hour = 0;
  }

  return { minutes: hour * 60 + minute, meridiem };
}

/**
 * Resolves the time portion into a minute window within the day, plus whether
 * the user specified an explicit start time.
 */
function resolveTimeWindow(timeStr: string | undefined): {
  startMinutes: number;
  endMinutes: number;
  explicit: boolean;
} {
  if (!timeStr) {
    return { ...DEFAULT_DAY, explicit: false };
  }

  const text = timeStr.trim().toLowerCase();

  const period = DAY_PERIODS[text];
  if (period) {
    return { ...period, explicit: false };
  }

  // Range, e.g. "8-9pm", "8pm-9pm", "20:00-21:00".
  const rangeMatch = text.match(/^(.+?)\s*[-–to]+\s*(.+)$/);
  if (rangeMatch) {
    const second = parseClock(rangeMatch[2]);
    const first = parseClock(rangeMatch[1], second?.meridiem);
    if (first && second && second.minutes > first.minutes) {
      return {
        startMinutes: first.minutes,
        endMinutes: second.minutes,
        explicit: true,
      };
    }
  }

  // Single time, e.g. "7pm" → 1-hour block.
  const single = parseClock(text);
  if (single) {
    return {
      startMinutes: single.minutes,
      endMinutes: single.minutes + 60,
      explicit: true,
    };
  }

  return { ...DEFAULT_DAY, explicit: false };
}

/**
 * Combines a fuzzy date and time into a concrete timezone-aware window.
 */
export function resolveWindow(
  dateStr: string | undefined,
  timeStr: string | undefined,
  zone: string,
  now: DateTime = DateTime.now().setZone(zone),
): ResolvedWindow {
  const day = resolveDate(dateStr, zone, now);
  const { startMinutes, endMinutes, explicit } = resolveTimeWindow(timeStr);

  return {
    start: day.plus({ minutes: startMinutes }),
    end: day.plus({ minutes: endMinutes }),
    explicit,
  };
}
