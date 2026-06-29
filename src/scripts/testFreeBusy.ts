/**
 * Standalone test for the Google Calendar FreeBusy availability check.
 *
 * Runs checkAvailability(startISO, endISO) against the real calendar and prints
 * the result. Useful for verifying FreeBusy works before wiring it elsewhere.
 *
 * Run with:  npx ts-node src/scripts/testFreeBusy.ts
 *       or:  npm run test:freebusy
 */

import dotenv from 'dotenv';
import { checkAvailability } from '../services/googleCalendarService';

dotenv.config();

const START_ISO = '2026-06-28T19:00:00+08:00';
const END_ISO = '2026-06-28T20:00:00+08:00';

async function main(): Promise<void> {
  console.log('[TEST] FreeBusy availability check');
  console.log(`[TEST] Range: ${START_ISO} -> ${END_ISO}`);

  const result = await checkAvailability(START_ISO, END_ISO);

  console.log('[TEST] Result:', JSON.stringify(result, null, 2));
  console.log(
    result.available
      ? '[TEST] ✅ Slot is AVAILABLE (no busy intervals).'
      : '[TEST] ⛔ Slot is BUSY or could not be verified.',
  );
}

main().catch((error: unknown) => {
  console.error(
    '[ERROR]',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
