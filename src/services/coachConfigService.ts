/**
 * Coach configuration helpers.
 *
 * Two responsibilities:
 *  1. Working-hours validation that operates on an explicit WorkingHours map +
 *     timezone (so it works per-coach in the multi-coach flow).
 *  2. Env-based defaults (getCoachConfig / parseWorkingHours) used to seed the
 *     first coach and as a local fallback.
 *
 * WorkingHours shape (day keys sun..sat; empty array = closed):
 *   {"sun":[{"start":"18:00","end":"22:00"}],"tue":[]}
 */

import { DateTime } from 'luxon';
import { logger } from './logger';
import { WorkingHours, WorkingInterval } from '../types/coach';

// Index 0..6 maps to luxon `weekday % 7` (Sun=0, Mon=1, ... Sat=6).
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'] as const;

const DEFAULT_INTERVAL: WorkingInterval = { start: '18:00', end: '22:00' };

const DEFAULT_WORKING_HOURS: WorkingHours = DAY_KEYS.reduce<WorkingHours>(
  (acc, key) => {
    acc[key] = [{ ...DEFAULT_INTERVAL }];
    return acc;
  },
  {},
);

export interface CoachConfig {
  timezone: string;
  sessionDurationMinutes: number;
  bufferMinutes: number;
  workingHours: WorkingHours;
}

let cached: CoachConfig | null = null;

function toMinutes(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

function isValidInterval(value: unknown): value is WorkingInterval {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<WorkingInterval>;
  if (typeof candidate.start !== 'string' || typeof candidate.end !== 'string') {
    return false;
  }
  const start = toMinutes(candidate.start);
  const end = toMinutes(candidate.end);
  return start !== null && end !== null && start < end;
}

/**
 * Parses a WORKING_HOURS_JSON string into a validated WorkingHours map.
 * Returns defaults (every day 18:00–22:00) if missing or unparseable.
 * Days present but with an empty array are kept (closed days).
 */
export function parseWorkingHours(raw: string | undefined): WorkingHours {
  if (!raw || raw.trim() === '') {
    return DEFAULT_WORKING_HOURS;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: WorkingHours = {};

    for (const key of DAY_KEYS) {
      const intervals = parsed[key];
      if (Array.isArray(intervals) && intervals.every(isValidInterval)) {
        result[key] = intervals as WorkingInterval[];
      }
    }

    if (Object.keys(result).length === 0) {
      logger.warn(
        '[COACH CONFIG] WORKING_HOURS_JSON parsed but contained no valid days; using defaults.',
      );
      return DEFAULT_WORKING_HOURS;
    }

    return result;
  } catch (error) {
    logger.warn(
      '[COACH CONFIG] Failed to parse WORKING_HOURS_JSON; using defaults.',
      error,
    );
    return DEFAULT_WORKING_HOURS;
  }
}

/**
 * Env-based coach defaults (used by the seed script and as a local fallback).
 */
export function getCoachConfig(): CoachConfig {
  if (cached) {
    return cached;
  }

  const sessionDuration = Number(process.env.SESSION_DURATION_MINUTES);
  const buffer = Number(process.env.BUFFER_MINUTES);

  cached = {
    timezone: process.env.COACH_TIMEZONE ?? 'Asia/Hong_Kong',
    sessionDurationMinutes:
      Number.isFinite(sessionDuration) && sessionDuration > 0
        ? sessionDuration
        : 60,
    bufferMinutes: Number.isFinite(buffer) && buffer >= 0 ? buffer : 0,
    workingHours: parseWorkingHours(process.env.WORKING_HOURS_JSON),
  };

  return cached;
}

/** Test helper: clears the cached config so env changes take effect. */
export function resetCoachConfigCache(): void {
  cached = null;
}

function dayKeyFor(dt: DateTime): string {
  return DAY_KEYS[dt.weekday % 7];
}

/**
 * Returns true when the [startISO, endISO) session fits entirely inside one of
 * the coach's working intervals for that day (in the coach's timezone).
 */
export function isWithinWorkingHours(
  workingHours: WorkingHours,
  timezone: string,
  startISO: string,
  endISO: string,
): boolean {
  const start = DateTime.fromISO(startISO, { zone: timezone });
  const end = DateTime.fromISO(endISO, { zone: timezone });
  if (!start.isValid || !end.isValid) {
    return false;
  }

  const intervals = workingHours[dayKeyFor(start)] ?? [];
  const startMin = start.hour * 60 + start.minute;
  const endMin = end.hour * 60 + end.minute;

  return intervals.some((interval) => {
    const open = toMinutes(interval.start);
    const close = toMinutes(interval.end);
    return open !== null && close !== null && startMin >= open && endMin <= close;
  });
}

/**
 * Short, friendly description of the working window for the day of `startISO`,
 * in the requested language. Used when a request falls outside working hours.
 */
export function describeWorkingWindow(
  workingHours: WorkingHours,
  timezone: string,
  startISO: string,
  language: 'zh' | 'en',
): string {
  const start = DateTime.fromISO(startISO, { zone: timezone });
  const intervals = start.isValid
    ? workingHours[dayKeyFor(start)] ?? []
    : [];

  if (intervals.length === 0) {
    return language === 'zh'
      ? '嗰個時間暫時唔開放預約 😅 可以揀教練可上堂時間。'
      : "That time is outside the coach's available hours 😅 want to try another slot?";
  }

  const weekdayZh = WEEKDAY_ZH[start.weekday % 7];
  const dayNameEn = start.toFormat('cccc');
  const ranges = intervals.map((iv) => `${iv.start}–${iv.end}`);

  return language === 'zh'
    ? `星期${weekdayZh}嘅上堂時間係 ${ranges.join('、')} ⏰ 揀個時間？`
    : `Our ${dayNameEn} hours are ${ranges.join(', ')} ⏰ pick a time in there?`;
}
