/**
 * Per-coach Google OAuth (Calendar) configuration.
 *
 * Each coach can connect their own Google Calendar via OAuth instead of the
 * shared service account. This module builds OAuth2 clients, generates the
 * consent URL, exchanges authorization codes for tokens, and persists tokens
 * (including silently-refreshed access tokens) back to the coach's Firestore
 * document.
 *
 * Env vars:
 *   - GOOGLE_OAUTH_CLIENT_ID
 *   - GOOGLE_OAUTH_CLIENT_SECRET
 *   - GOOGLE_OAUTH_REDIRECT_URI (optional; derived from BASE_URL when unset)
 *
 * Security: tokens are never logged or returned in responses.
 */

import { google, calendar_v3, Auth } from 'googleapis';
import { getFirestore } from './firebaseAdmin';
import { getGoogleRedirectUri } from './baseUrl';
// Use the OAuth2 client type as constructed by googleapis to avoid clashes
// between the two bundled google-auth-library copies.
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
import { logger } from '../services/logger';
import { resetCoachCache } from '../services/coachResolverService';
import { Coach } from '../types/coach';

export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

const COACHES_COLLECTION = 'coaches';

/**
 * Builds a fresh OAuth2 client from env. Throws clearly if OAuth env vars are
 * missing so callers fail fast.
 */
export function getOAuthClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Google OAuth not configured: set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.',
    );
  }

  // Redirect URI is derived from BASE_URL unless GOOGLE_OAUTH_REDIRECT_URI is set.
  const redirectUri = getGoogleRedirectUri();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Returns the Google consent URL for a coach. The coachId is carried in the
 * `state` param and validated on callback.
 */
export function generateAuthUrl(coachId: string): string {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token on every connect
    scope: OAUTH_SCOPES,
    state: coachId,
    include_granted_scopes: true,
  });
}

export interface ExchangedTokens {
  accessToken?: string;
  refreshToken?: string;
  expiryDate?: number;
}

/**
 * Exchanges an authorization code for tokens. Never logs token values.
 */
export async function exchangeCodeForTokens(
  code: string,
): Promise<ExchangedTokens> {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  return {
    accessToken: tokens.access_token ?? undefined,
    refreshToken: tokens.refresh_token ?? undefined,
    expiryDate: tokens.expiry_date ?? undefined,
  };
}

/**
 * Persists silently-refreshed tokens (emitted by the OAuth2 client) back to the
 * coach document. Only writes fields that are present; never overwrites an
 * existing refresh_token with undefined.
 */
async function persistRefreshedTokens(
  coachId: string,
  tokens: Auth.Credentials,
): Promise<void> {
  const db = getFirestore();
  if (!db) {
    return;
  }

  const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (tokens.access_token) {
    update['calendar.accessToken'] = tokens.access_token;
  }
  if (tokens.expiry_date) {
    update['calendar.expiryDate'] = tokens.expiry_date;
  }
  if (tokens.refresh_token) {
    update['calendar.refreshToken'] = tokens.refresh_token;
  }

  try {
    await db.collection(COACHES_COLLECTION).doc(coachId).update(update);
    resetCoachCache();
    logger.info(`[OAUTH] Refreshed Google tokens persisted for coach=${coachId}.`);
  } catch (error) {
    logger.error(`[OAUTH] Failed to persist refreshed tokens for coach=${coachId}.`, error);
  }
}

/**
 * Builds a Calendar client authenticated as the coach via OAuth. Registers a
 * listener so any silently-refreshed access token is persisted to Firestore.
 */
export function buildOAuthCalendarClient(coach: Coach): calendar_v3.Calendar {
  const client = getOAuthClient();
  client.setCredentials({
    access_token: coach.calendar.accessToken,
    refresh_token: coach.calendar.refreshToken,
    expiry_date: coach.calendar.expiryDate,
  });

  client.on('tokens', (tokens) => {
    void persistRefreshedTokens(coach.coachId, tokens);
  });

  return google.calendar({ version: 'v3', auth: client });
}

/**
 * Saves freshly-exchanged OAuth tokens to the coach's calendar config and flips
 * the coach to OAuth mode. Activates the coach when WhatsApp is also ready.
 * Returns true on success.
 */
export async function saveCoachOAuthTokens(
  coach: Coach,
  tokens: ExchangedTokens,
): Promise<boolean> {
  const db = getFirestore();
  if (!db) {
    logger.error('[OAUTH] Firestore unavailable; cannot save coach tokens.');
    return false;
  }

  const whatsappReady = Boolean(
    coach.whatsapp?.phoneNumberId && coach.whatsapp?.accessToken,
  );

  const update: Record<string, unknown> = {
    'calendar.provider': 'google',
    'calendar.serviceAccountMode': false,
    'calendar.calendarId': coach.calendar.calendarId || 'primary',
    updatedAt: new Date().toISOString(),
  };
  if (tokens.accessToken) {
    update['calendar.accessToken'] = tokens.accessToken;
  }
  if (tokens.refreshToken) {
    update['calendar.refreshToken'] = tokens.refreshToken;
  }
  if (tokens.expiryDate) {
    update['calendar.expiryDate'] = tokens.expiryDate;
  }
  if (whatsappReady) {
    update.status = 'active';
  }

  try {
    await db.collection(COACHES_COLLECTION).doc(coach.coachId).update(update);
    resetCoachCache();
    logger.info(
      `[OAUTH] Google Calendar connected for coach=${coach.coachId} (status=${whatsappReady ? 'active' : coach.status}).`,
    );
    return true;
  } catch (error) {
    logger.error(`[OAUTH] Failed to save tokens for coach=${coach.coachId}.`, error);
    return false;
  }
}
