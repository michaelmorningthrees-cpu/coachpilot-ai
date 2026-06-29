/**
 * Resolves a fuzzy date + time (English or Chinese/Cantonese) into a concrete
 * ISO slot in the Asia/Hong_Kong timezone. Session length comes from the coach
 * config (SESSION_DURATION_MINUTES, default 60).
 *
 * Examples it handles:
 *   - "Sunday" + "7pm"        → Sunday 19:00–20:00
 *   - "next Monday" + "6pm"   → next Monday 18:00–19:00
 *   - "星期日" + "夜晚7點"     → Sunday 19:00–20:00
 *   - "聽晚" + "8點"           → tomorrow 20:00–21:00
 *
 * Returns null when a concrete start time cannot be determined, so the caller
 * can ask the student to clarify instead of falling back to a hardcoded slot.
 */

import { DateTime } from 'luxon';
import { resolveWindow } from '../utils/dateParser';
import { DEFAULT_TIMEZONE } from '../config/googleAuth';

const DEFAULT_SESSION_MINUTES = 60;

export interface ResolvedSlot {
  startISO: string;
  endISO: string;
}

const ZH_WEEKDAY: Record<string, string> = {
  日: 'sunday',
  天: 'sunday',
  一: 'monday',
  二: 'tuesday',
  三: 'wednesday',
  四: 'thursday',
  五: 'friday',
  六: 'saturday',
};

const ZH_NUMBER: Record<string, number> = {
  零: 0,
  一: 1,
  兩: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
};

/**
 * Translates a (possibly Chinese) date phrase into a token the English-based
 * dateParser understands ("today", "tomorrow", "sunday", "next monday", ...).
 * Falls through to the original string if it already looks English.
 */
function translateDate(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const s = raw.trim();

  // Cantonese/Chinese relative days, including colloquial 聽晚/今晚/聽朝 etc.
  if (/今(日|天|晚|朝)/.test(s)) return 'today';
  if (/(聽|聼|明)(日|天|晚|朝)/.test(s)) return 'tomorrow';
  if (/後(日|天|晚|朝)/.test(s)) return 'day after tomorrow';

  // 星期X / 禮拜X / 拜X / 週X / 周X  (X = 日一二三四五六天)
  const match = s.match(/(?:星期|禮拜|拜|週|周)\s*([日一二三四五六天])/);
  if (match) {
    const weekday = ZH_WEEKDAY[match[1]];
    if (weekday) {
      const isNext = /下\s*(?:個|個)?\s*(?:星期|禮拜|週|周)/.test(s);
      return isNext ? `next ${weekday}` : weekday;
    }
  }

  return raw;
}

/**
 * Translates a (possibly Chinese) time phrase into an English clock token the
 * dateParser understands ("7pm", "8:30am", "19:00"). Returns the original
 * string when it already looks English or no concrete hour is present.
 */
function translateTime(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const s = raw.trim();

  // Already English (e.g. "7pm", "8:30am", "19:00", "evening")? Pass through
  // untouched — the dateParser already understands these and applying our
  // Chinese rules here would wrongly strip the am/pm meridiem.
  if (!/[\u4e00-\u9fff]/.test(s)) {
    return raw;
  }

  const isPm = /(下午|晚上|夜晚|夜|晚|黃昏|傍晚)/.test(s);
  const isAm = /(朝早|早上|上午|清晨|朝)/.test(s);

  // Arabic hour, optionally with :mm.
  let hour: number | null = null;
  let minutePart = '';

  const arabic = s.match(/(\d{1,2})(?:[:：](\d{2}))?/);
  if (arabic) {
    hour = Number(arabic[1]);
    if (arabic[2]) {
      minutePart = `:${arabic[2]}`;
    }
  } else {
    const chinese = s.match(/([零一二三四五六七八九十]+)\s*(?:點|時|点|时)/);
    if (chinese && ZH_NUMBER[chinese[1]] !== undefined) {
      hour = ZH_NUMBER[chinese[1]];
    }
  }

  if (hour === null) {
    // No concrete hour (e.g. "夜晚" alone) — return raw so the dateParser
    // marks it non-explicit and the caller asks for clarification.
    return raw;
  }

  // Hours given in 24h form (e.g. "19點") need no meridiem.
  if (hour > 12) {
    return `${hour}${minutePart}`;
  }
  // Cantonese booking context: a bare hour like "6點" (1–11, no am/pm marker)
  // almost always means evening for coaching sessions — assume PM. This is a
  // Chinese-only heuristic; English bare numbers are passed through earlier.
  const assumePm = !isPm && !isAm && hour >= 1 && hour <= 11;
  if (isPm || assumePm) return `${hour}${minutePart}pm`;
  if (isAm) return `${hour}${minutePart}am`;
  return `${hour}${minutePart}`;
}

/**
 * Resolves date + time into a concrete ISO slot, or null if the time is not
 * specific enough to act on.
 *
 * @param now           Anchor "now" (defaults to current time in the timezone).
 * @param timezone      Coach timezone (defaults to Asia/Hong_Kong).
 * @param durationMinutes Session length (defaults to 60).
 */
export function resolveSlot(
  dateStr: string | undefined,
  timeStr: string | undefined,
  now?: DateTime,
  timezone: string = DEFAULT_TIMEZONE,
  durationMinutes: number = DEFAULT_SESSION_MINUTES,
): ResolvedSlot | null {
  const anchor = now ?? DateTime.now().setZone(timezone);
  const dateEn = translateDate(dateStr);
  const timeEn = translateTime(timeStr);

  const window = resolveWindow(dateEn, timeEn, timezone, anchor);

  // Require an explicit start time — never guess a slot.
  if (!window.explicit) {
    return null;
  }

  const startISO = window.start.toISO({ suppressMilliseconds: true });
  const endISO = window.start
    .plus({ minutes: durationMinutes })
    .toISO({ suppressMilliseconds: true });

  if (!startISO || !endISO) {
    return null;
  }

  return { startISO, endISO };
}
