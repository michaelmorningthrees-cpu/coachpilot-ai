/**
 * WhatsApp reply engine (Step 4).
 *
 * Turns the structured outputs of Steps 2 & 3 (intent + calendar result) into
 * short, friendly, HK-style WhatsApp replies. Deterministic and template-based
 * so replies stay predictable, fast, and free of LLM cost.
 */

import { DateTime } from 'luxon';
import { SchedulingIntent } from '../types/intent';
import { DEFAULT_TIMEZONE } from '../config/googleAuth';
import {
  CheckAvailabilityResult,
  CreateBookingResult,
} from './googleCalendarService';

const MAX_SUGGESTED_SLOTS = 3;

export interface GenerateReplyInput {
  intent: SchedulingIntent;
  userMessage: string;
  availability?: CheckAvailabilityResult;
  booking?: CreateBookingResult;
}

/**
 * Formats a single hour like 19 -> "7pm", 12 -> "12pm", 9 -> "9am".
 */
function formatHour(dt: DateTime): string {
  const hour12 = dt.hour % 12 === 0 ? 12 : dt.hour % 12;
  const meridiem = dt.hour < 12 ? 'am' : 'pm';
  const minutePart = dt.minute === 0 ? '' : `:${dt.minute.toString().padStart(2, '0')}`;
  return `${hour12}${minutePart}${meridiem}`;
}

/**
 * Formats a 1-hour slot starting at `startIso` as "7–8pm" (drops the redundant
 * meridiem on the start when both ends share one, e.g. "7–8pm" not "7pm–8pm").
 */
function formatSlotRange(startIso: string): string {
  const start = DateTime.fromISO(startIso, { zone: DEFAULT_TIMEZONE });
  const end = start.plus({ hours: 1 });

  const startMeridiem = start.hour < 12 ? 'am' : 'pm';
  const endMeridiem = end.hour < 12 ? 'am' : 'pm';
  const startLabel = formatHour(start);
  const endLabel = formatHour(end);

  if (startMeridiem === endMeridiem) {
    // Strip meridiem from the start: "7pm" + "8pm" -> "7–8pm".
    return `${startLabel.replace(/(am|pm)$/, '')}–${endLabel}`;
  }
  return `${startLabel}–${endLabel}`;
}

/**
 * Human-friendly day label relative to now: "today", "tomorrow", or weekday.
 */
function formatDayLabel(startIso: string): string {
  const start = DateTime.fromISO(startIso, { zone: DEFAULT_TIMEZONE });
  const today = DateTime.now().setZone(DEFAULT_TIMEZONE).startOf('day');
  const diffDays = Math.round(start.startOf('day').diff(today, 'days').days);

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  return start.toFormat('cccc');
}

/**
 * Joins slot labels into a natural list: ["a","b","c"] -> "a, b or c".
 */
function joinWithOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/**
 * Builds a phrase describing free slots, grouped by day when they share one,
 * e.g. "Wednesday 7–8pm or 8–9pm" or "Wednesday 7–8pm or Thursday 6–7pm".
 */
function describeSlots(slots: string[]): string {
  const chosen = slots.slice(0, MAX_SUGGESTED_SLOTS);
  const days = new Set(chosen.map((iso) => formatDayLabel(iso)));

  if (days.size === 1) {
    const day = formatDayLabel(chosen[0]);
    const ranges = chosen.map((iso) => formatSlotRange(iso));
    return `${day} ${joinWithOr(ranges)}`;
  }

  const labelled = chosen.map(
    (iso) => `${formatDayLabel(iso)} ${formatSlotRange(iso)}`,
  );
  return joinWithOr(labelled);
}

function replyForAvailability(availability?: CheckAvailabilityResult): string {
  if (availability && availability.available && availability.slots.length > 0) {
    return `${describeSlots(availability.slots)} 👍 which one works for you?`;
  }
  return 'Ah that time looks full 😅 want me to check another day or time?';
}

function replyForBooking(booking?: CreateBookingResult): string {
  if (booking && booking.success) {
    const day = formatDayLabel(booking.start);
    const range = formatSlotRange(booking.start);
    return `Done 👍 booked you ${day} ${range} 🏀 see you!`;
  }

  const reason = booking && !booking.success ? booking.reason : '';

  if (/already booked|overlap|taken/i.test(reason)) {
    return 'Ah that slot just got taken 😅 want another time?';
  }
  if (/no specific|vague|start time/i.test(reason)) {
    return 'Sure! What time works for you? ⏰';
  }
  if (/past/i.test(reason)) {
    return 'That time has already passed 😅 pick another one?';
  }
  return 'Hmm I couldn’t lock that in 😅 can you tell me the day and time again?';
}

function replyForReschedule(availability?: CheckAvailabilityResult): string {
  if (availability && availability.available && availability.slots.length > 0) {
    return `No problem 👍 I can move you to ${describeSlots(availability.slots)} 🏀`;
  }
  return 'No problem 👍 which day works better for you?';
}

/**
 * Generates a natural WhatsApp reply for the given intent and calendar result.
 * Always returns a non-empty string.
 */
export function generateReply(input: GenerateReplyInput): string {
  switch (input.intent) {
    case 'provide_datetime':
      return replyForAvailability(input.availability);
    case 'new_booking':
      return replyForBooking(input.booking);
    case 'reschedule_booking':
      return replyForReschedule(input.availability);
    default:
      return 'Hi 🏀 when would you like to train? I can check the schedule for you 👍';
  }
}
