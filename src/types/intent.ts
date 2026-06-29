/**
 * Type definitions for the AI scheduling intent parser.
 * Three scheduling intents plus an "unknown" safe fallback.
 */

export type SchedulingIntent =
  | 'check_availability'
  | 'create_booking'
  | 'reschedule_request'
  | 'unknown';

export const SCHEDULING_INTENTS: readonly SchedulingIntent[] = [
  'check_availability',
  'create_booking',
  'reschedule_request',
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
