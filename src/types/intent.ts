/**
 * Type definitions for the AI scheduling intent parser.
 * Three scheduling intents plus an "unknown" safe fallback.
 */

export type SchedulingIntent =
  | 'greeting'
  | 'new_booking'
  | 'provide_datetime'
  | 'check_my_booking'
  | 'cancel_booking'
  | 'reschedule_booking'
  | 'faq'
  | 'unknown';

export const SCHEDULING_INTENTS: readonly SchedulingIntent[] = [
  'greeting',
  'new_booking',
  'provide_datetime',
  'check_my_booking',
  'cancel_booking',
  'reschedule_booking',
  'faq',
  'unknown',
] as const;

/**
 * Structured result returned by {@link parseIntent}.
 * `date` and `time` are optional free-text extractions (e.g. "Wednesday",
 * "evening", "7pm") and are left undefined when the user did not specify them.
 */
export interface IntentResult {
  intent: SchedulingIntent;
  date?: string;
  time?: string;
  confidence: number;
  raw_message: string;
}
