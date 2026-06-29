/**
 * Standalone, offline test for the date/time resolver.
 *
 * Anchors "now" to a fixed Wednesday so weekday math is deterministic and
 * checks English + Chinese/Cantonese phrasings, plus vague inputs that must
 * return null (so the bot asks for clarification instead of guessing).
 *
 * Run with:  npx ts-node src/scripts/testDateTimeResolver.ts
 *       or:  npm run test:resolver
 */

import { DateTime } from 'luxon';
import { resolveSlot } from '../services/dateTimeResolver';

const ZONE = 'Asia/Hong_Kong';
// 2026-06-24 is a Wednesday.
const NOW = DateTime.fromISO('2026-06-24T12:00:00', { zone: ZONE });

let failures = 0;

function check(
  label: string,
  date: string | undefined,
  time: string | undefined,
  expected: { weekday: string; hour: number } | null,
): void {
  const slot = resolveSlot(date, time, NOW);

  if (expected === null) {
    if (slot === null) {
      console.log(`  ✅ ${label} → null (asks for clarification)`);
    } else {
      failures += 1;
      console.error(`  ❌ ${label} → expected null but got ${slot.startISO}`);
    }
    return;
  }

  if (!slot) {
    failures += 1;
    console.error(`  ❌ ${label} → expected a slot but got null`);
    return;
  }

  const start = DateTime.fromISO(slot.startISO, { zone: ZONE });
  const end = DateTime.fromISO(slot.endISO, { zone: ZONE });
  const weekday = start.toFormat('cccc');
  const okWeekday = weekday.toLowerCase() === expected.weekday.toLowerCase();
  const okHour = start.hour === expected.hour;
  const okDuration = end.diff(start, 'minutes').minutes === 60;

  if (okWeekday && okHour && okDuration) {
    console.log(`  ✅ ${label} → ${weekday} ${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}`);
  } else {
    failures += 1;
    console.error(
      `  ❌ ${label} → got ${weekday} ${start.toFormat('HH:mm')} (expected ${expected.weekday} ${expected.hour}:00, 60min=${okDuration})`,
    );
  }
}

function main(): void {
  console.log('[TEST] dateTimeResolver (now = Wed 2026-06-24 12:00 HKT)\n');

  console.log('[TEST] English');
  check('Sunday 7pm', 'Sunday', '7pm', { weekday: 'Sunday', hour: 19 });
  check('tomorrow 8pm', 'tomorrow', '8pm', { weekday: 'Thursday', hour: 20 });
  check('next Monday 6pm', 'next Monday', '6pm', { weekday: 'Monday', hour: 18 });

  console.log('\n[TEST] Chinese / Cantonese');
  check('星期日 夜晚7點', '星期日', '夜晚7點', { weekday: 'Sunday', hour: 19 });
  check('聽晚 8點', '聽晚', '8點', { weekday: 'Thursday', hour: 20 });
  check('下星期一 6點', '下星期一', '6點', { weekday: 'Monday', hour: 18 });

  console.log('\n[TEST] Vague → null');
  check('Sunday (no time)', 'Sunday', undefined, null);
  check('evening only', undefined, 'evening', null);
  check('夜晚 only', undefined, '夜晚', null);

  console.log('');
  if (failures === 0) {
    console.log('[TEST] ✅ All dateTimeResolver checks passed.');
    process.exit(0);
  } else {
    console.error(`[TEST] ❌ ${failures} check(s) failed.`);
    process.exit(1);
  }
}

main();
