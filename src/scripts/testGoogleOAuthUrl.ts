/**
 * Prints the Google OAuth "start" URL for the default coach so you can begin
 * the consent flow locally. Does not call Google or touch Firestore.
 *
 * Run:  npm run test:oauth:url
 *
 * Required env: DEFAULT_COACH_ID, and (to also print the live Google consent
 * URL) GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET /
 * GOOGLE_OAUTH_REDIRECT_URI.
 */

import 'dotenv/config';

import { generateAuthUrl } from '../config/googleOAuth';

function main(): void {
  const coachId = process.env.DEFAULT_COACH_ID;
  if (!coachId) {
    console.error('❌ DEFAULT_COACH_ID is not set in .env.');
    process.exit(1);
  }

  const port = process.env.PORT ?? '3001';
  const startUrl = `http://localhost:${port}/oauth/google/start?coachId=${encodeURIComponent(
    coachId,
  )}`;

  console.log('[OAUTH] Open this local URL to begin connecting Google Calendar:');
  console.log(`  ${startUrl}\n`);

  try {
    const googleUrl = generateAuthUrl(coachId);
    console.log('[OAUTH] (For reference) the Google consent URL it redirects to:');
    console.log(`  ${googleUrl}`);
  } catch (error) {
    console.log(
      '[OAUTH] ⚠️  Could not build the Google consent URL (OAuth env vars not set yet):',
    );
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }

  process.exit(0);
}

main();
