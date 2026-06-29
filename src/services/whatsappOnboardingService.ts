/**
 * WhatsApp Embedded Signup foundation.
 *
 * The dashboard launches Meta's Embedded Signup (Facebook JS SDK). On success
 * the browser receives:
 *   - an authorization `code` (from FB.login response_type=code)
 *   - the new WABA id + phone number id (from the WA_EMBEDDED_SIGNUP message)
 *
 * This service exchanges the code for a business access token and stores the
 * resulting WhatsApp config on the coach. Tokens are never logged.
 *
 * NOTE: A fully working Embedded Signup requires a Meta App configured as a
 * Tech Provider with an Embedded Signup configuration (WHATSAPP_CONFIG_ID) and
 * App Review. This is the backend foundation for that flow.
 *
 * Env vars:
 *   - WHATSAPP_APP_ID
 *   - WHATSAPP_APP_SECRET   (already used for webhook signature verification)
 *   - WHATSAPP_CONFIG_ID    (Embedded Signup configuration id, used by the UI)
 *   - WHATSAPP_API_VERSION  (optional, defaults to v22.0)
 */

import { logger } from './logger';

const API_VERSION = process.env.WHATSAPP_API_VERSION ?? 'v22.0';

export interface EmbeddedSignupConfig {
  appId: string;
  configId: string;
  apiVersion: string;
}

/** Returns the front-end Embedded Signup config, or null if not configured. */
export function getEmbeddedSignupConfig(): EmbeddedSignupConfig | null {
  const appId = process.env.WHATSAPP_APP_ID;
  const configId = process.env.WHATSAPP_CONFIG_ID;
  if (!appId || !configId) {
    return null;
  }
  return { appId, configId, apiVersion: API_VERSION };
}

/**
 * Exchanges an Embedded Signup authorization code for a business access token.
 * Throws on failure (caller logs a generic error; token is never logged).
 */
export async function exchangeEmbeddedSignupCode(code: string): Promise<string> {
  const appId = process.env.WHATSAPP_APP_ID;
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('Missing WHATSAPP_APP_ID or WHATSAPP_APP_SECRET.');
  }

  const url =
    `https://graph.facebook.com/${API_VERSION}/oauth/access_token` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&code=${encodeURIComponent(code)}`;

  const response = await fetch(url, { method: 'GET' });
  const rawBody = await response.text();

  if (!response.ok) {
    logger.error(
      `[WA ONBOARDING] Code exchange failed status=${response.status} body=${rawBody}`,
    );
    throw new Error(`Meta token exchange failed (status ${response.status}).`);
  }

  const data = JSON.parse(rawBody) as { access_token?: string };
  if (!data.access_token) {
    throw new Error('Meta did not return an access token.');
  }

  logger.info('[WA ONBOARDING] Embedded Signup code exchanged successfully.');
  return data.access_token;
}
