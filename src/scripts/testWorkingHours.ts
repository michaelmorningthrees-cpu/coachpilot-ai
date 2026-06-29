/**
 * Standalone, offline test for per-coach working-hours validation.
 *
 * Uses a fixed working-hours map (Sun 18:00–22:00, Sat 10:00–18:00, all other
 * days closed) so results are deterministic regardless of .env.
 *
 * Run with:  npx ts-node src/scripts/testWorkingHours.ts
 *       or:  npm run test:workinghours
 */

import { DateTime } from 'luxon';
import {
  isWithinWorkingHours,
  describeWorkingWindow,
} from '../services/coachConfigService';
import { WorkingHours } from '../types/coach';

const TZ = 'Asia/Hong_Kong';
const HOURS: WorkingHours = {
  sun: [{ start: '18:00', end: '22:00' }],
  sat: [{ start: '10:00', end: '18:00' }],
};

/** Returns [startISO, endISO] for a 1-hour session starting at startISO. */
function slot(startISO: string): [string, string] {
  const end = DateTime.fromISO(startISO, { zone: TZ })
    .plus({ hours: 1 })
    .toISO({ suppressMilliseconds: true });
  return [startISO, end ?? startISO];
}

let failures = 0;

function expect(label: string, actual: boolean, expected: boolean): void {
  if (actual === expected) {
    console.log(`  ✅ ${label} → ${actual}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${label} → got ${actual}, expected ${expected}`);
  }
}

function within(startISO: string): boolean {
  const [s, e] = slot(startISO);
  return isWithinWorkingHours(HOURS, TZ, s, e);
}

function expectContains(label: string, text: string, needle: string): void {
  if (text.includes(needle)) {
    console.log(`  ✅ ${label} → "${text}"`);
  } else {
    failures += 1;
    console.error(`  ❌ ${label} → "${text}" does not contain "${needle}"`);
  }
}

function main(): void {
  console.log('[TEST] Working hours (Sun 18–22, Sat 10–18, else closed)\n');

  // 2026-06-28 = Sunday, 2026-06-27 = Saturday, 2026-06-30 = Tuesday.
  console.log('[TEST] isWithinWorkingHours');
  expect('Sun 19:00', within('2026-06-28T19:00:00+08:00'), true);
  expect('Sun 17:00 (before open)', within('2026-06-28T17:00:00+08:00'), false);
  expect('Sun 21:30 (end spills past 22:00)', within('2026-06-28T21:30:00+08:00'), false);
  expect('Sat 11:00', within('2026-06-27T11:00:00+08:00'), true);
  expect('Tue 19:00 (closed day)', within('2026-06-30T19:00:00+08:00'), false);

  console.log('\n[TEST] describeWorkingWindow');
  expectContains(
    'Closed day (en)',
    describeWorkingWindow(HOURS, TZ, '2026-06-30T19:00:00+08:00', 'en'),
    'outside',
  );
  expectContains(
    'Open day (zh)',
    describeWorkingWindow(HOURS, TZ, '2026-06-28T17:00:00+08:00', 'zh'),
    '18:00',
  );

  console.log('');
  if (failures === 0) {
    console.log('[TEST] ✅ All working-hours checks passed.');
    process.exit(0);
  } else {
    console.error(`[TEST] ❌ ${failures} check(s) failed.`);
    process.exit(1);
  }
}

main();
