/**
 * Standalone Google Calendar connection test for CoachPilot AI.
 *
 * Authenticates with the service account from .env and lists the next 5
 * upcoming events from GOOGLE_CALENDAR_ID. Useful for verifying credentials,
 * calendar sharing, and permissions before running the full webhook flow.
 *
 * Run with:  npx ts-node src/scripts/testCalendarConnection.ts
 *       or:  npm run test:calendar
 */

import dotenv from 'dotenv';
import { google } from 'googleapis';
import { GaxiosError } from 'gaxios';

dotenv.config();

const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

interface CalendarConfig {
  clientEmail: string;
  privateKey: string;
  calendarId: string;
}

function loadConfig(): CalendarConfig {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.GOOGLE_PRIVATE_KEY;
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  const missing: string[] = [];
  if (!clientEmail) missing.push('GOOGLE_CLIENT_EMAIL');
  if (!rawPrivateKey) missing.push('GOOGLE_PRIVATE_KEY');
  if (!calendarId) missing.push('GOOGLE_CALENDAR_ID');

  if (!clientEmail || !rawPrivateKey || !calendarId) {
    throw new Error(
      `Missing required env variable(s): ${missing.join(', ')}. ` +
        'Add them to your .env file.',
    );
  }

  return {
    clientEmail,
    // .env stores newlines as literal "\n"; restore them so the key parses.
    privateKey: rawPrivateKey.replace(/\\n/g, '\n'),
    calendarId,
  };
}

async function main(): Promise<void> {
  console.log('[TEST] Starting Google Calendar connection test...');

  const config = loadConfig();
  console.log(`[TEST] Service account: ${config.clientEmail}`);
  console.log(`[TEST] Calendar ID: ${config.calendarId}`);

  const auth = new google.auth.JWT({
    email: config.clientEmail,
    key: config.privateKey,
    scopes: CALENDAR_SCOPES,
  });

  const calendar = google.calendar({ version: 'v3', auth });

  console.log('[TEST] Fetching next 5 upcoming events...');
  const response = await calendar.events.list({
    calendarId: config.calendarId,
    timeMin: new Date().toISOString(),
    maxResults: 5,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = response.data.items ?? [];

  if (events.length === 0) {
    console.log('Calendar connected, no upcoming events');
    return;
  }

  console.log(`[TEST] Connected. Next ${events.length} upcoming event(s):`);
  events.forEach((event, index) => {
    const start =
      event.start?.dateTime ?? event.start?.date ?? '(no start time)';
    const summary = event.summary ?? '(no title)';
    console.log(`  ${index + 1}. ${summary} — ${start}`);
  });
}

main().catch((error: unknown) => {
  if (error instanceof GaxiosError) {
    const status = error.response?.status;
    if (status === 401) {
      console.error(
        '[ERROR] Authentication failed (401). Check GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY are correct and the key is not malformed.',
      );
    } else if (status === 403) {
      console.error(
        '[ERROR] Permission denied (403). Share the calendar with the service account email and grant at least "See all event details".',
      );
    } else if (status === 404) {
      console.error(
        '[ERROR] Calendar not found (404). Check that GOOGLE_CALENDAR_ID is correct.',
      );
    } else {
      console.error(
        `[ERROR] Google Calendar API error${status ? ` (${status})` : ''}:`,
        error.message,
      );
    }
  } else if (error instanceof Error) {
    console.error('[ERROR]', error.message);
  } else {
    console.error('[ERROR] Unknown error:', error);
  }
  process.exit(1);
});
