/**
 * Post-Embedded-Signup automation for a connected WhatsApp Business account.
 *
 * After a coach connects via Embedded Signup we still need to:
 *   1. validate the returned access token
 *   2. subscribe our app to the WABA's webhooks (so messages arrive)
 *   3. register the phone number (requires a two-step PIN)
 *
 * Every step is best-effort and never throws to the caller — failures are
 * captured as machine-readable warnings so onboarding is not blocked. Access
 * tokens are NEVER logged.
 *
 * Env vars:
 *   - WHATSAPP_API_VERSION   (default v25.0)
 *   - META_APP_ACCESS_TOKEN  (optional; used for debug_token validation)
 *   - WHATSAPP_APP_ID / WHATSAPP_APP_SECRET (fallback app access token)
 */

import { logger } from './logger';

const API_VERSION = process.env.WHATSAPP_API_VERSION ?? 'v25.0';
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;

export interface WhatsAppSetupStatus {
  tokenValidated: boolean;
  webhookSubscribed: boolean;
  phoneRegistered: boolean;
  setupWarnings: string[];
  lastSetupCheckAt: string;
}

/**
 * Returns the app access token used for debug_token, preferring an explicit
 * META_APP_ACCESS_TOKEN and falling back to "{APP_ID}|{APP_SECRET}".
 */
function getAppAccessToken(): string | null {
  const explicit = process.env.META_APP_ACCESS_TOKEN?.trim();
  if (explicit) {
    return explicit;
  }
  const appId = process.env.WHATSAPP_APP_ID?.trim();
  const appSecret = process.env.WHATSAPP_APP_SECRET?.trim();
  if (appId && appSecret) {
    return `${appId}|${appSecret}`;
  }
  return null;
}

/**
 * Validates a WhatsApp access token via the Graph debug_token endpoint.
 * Returns true when Meta reports the token as valid. Never logs the token.
 */
export async function validateMetaToken(accessToken: string): Promise<boolean> {
  const appAccessToken = getAppAccessToken();
  if (!appAccessToken) {
    logger.warn(
      '[WA TOKEN VALIDATE] Skipped — no META_APP_ACCESS_TOKEN / WHATSAPP_APP_ID+SECRET configured.',
    );
    return false;
  }

  try {
    const url =
      `${GRAPH}/debug_token` +
      `?input_token=${encodeURIComponent(accessToken)}` +
      `&access_token=${encodeURIComponent(appAccessToken)}`;

    const response = await fetch(url, { method: 'GET' });
    const data = (await response.json()) as {
      data?: { is_valid?: boolean };
      error?: unknown;
    };

    const valid = Boolean(response.ok && data.data?.is_valid);
    if (valid) {
      logger.info('[WA TOKEN VALIDATED]');
    } else {
      logger.warn(`[WA TOKEN VALIDATE] Token reported invalid (status ${response.status}).`);
    }
    return valid;
  } catch (error) {
    logger.error('[WA TOKEN VALIDATE] Request failed.', error);
    return false;
  }
}

export interface StepResult {
  success: boolean;
  /** Machine-readable warning code on failure/skip. */
  warning?: string;
}

/**
 * Subscribes our app to a WABA's webhooks so inbound messages are delivered.
 * Uses the coach's business access token as the bearer credential.
 */
export async function subscribeAppToWaba(params: {
  wabaId: string;
  accessToken: string;
}): Promise<StepResult> {
  try {
    const response = await fetch(`${GRAPH}/${encodeURIComponent(params.wabaId)}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${params.accessToken}` },
    });
    const raw = await response.text();

    if (!response.ok) {
      logger.error(
        `[WA WABA SUBSCRIBE] Failed status=${response.status} response=${raw}`,
      );
      return { success: false, warning: 'WEBHOOK_SUBSCRIPTION_FAILED' };
    }

    logger.info('[WA WABA SUBSCRIBED]');
    return { success: true };
  } catch (error) {
    logger.error('[WA WABA SUBSCRIBE] Request failed.', error);
    return { success: false, warning: 'WEBHOOK_SUBSCRIPTION_FAILED' };
  }
}

/**
 * Registers a WhatsApp phone number (Cloud API) using a two-step PIN.
 * When no PIN is supplied, registration is skipped (not an error).
 */
export async function registerPhoneNumber(params: {
  phoneNumberId: string;
  accessToken: string;
  pin?: string;
}): Promise<StepResult> {
  if (!params.pin) {
    logger.warn('[WA PHONE REGISTER] Skipped — no registration PIN provided.');
    return { success: false, warning: 'PHONE_REGISTRATION_PIN_REQUIRED' };
  }

  try {
    const response = await fetch(`${GRAPH}/${encodeURIComponent(params.phoneNumberId)}/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin: params.pin }),
    });
    const raw = await response.text();

    if (!response.ok) {
      logger.error(
        `[WA PHONE REGISTER] Failed status=${response.status} response=${raw}`,
      );
      return { success: false, warning: 'PHONE_REGISTRATION_FAILED' };
    }

    logger.info('[WA PHONE REGISTERED]');
    return { success: true };
  } catch (error) {
    logger.error('[WA PHONE REGISTER] Request failed.', error);
    return { success: false, warning: 'PHONE_REGISTRATION_FAILED' };
  }
}

/**
 * Runs the full post-signup setup (token → webhook → phone) best-effort and
 * returns the resulting status. Never throws.
 */
export async function runWhatsAppSetup(params: {
  accessToken: string;
  phoneNumberId: string;
  wabaId?: string;
  registrationPin?: string;
}): Promise<WhatsAppSetupStatus> {
  const warnings: string[] = [];

  const tokenValidated = await validateMetaToken(params.accessToken);
  if (!tokenValidated) {
    warnings.push('TOKEN_VALIDATION_FAILED');
  }

  let webhookSubscribed = false;
  if (params.wabaId) {
    const sub = await subscribeAppToWaba({
      wabaId: params.wabaId,
      accessToken: params.accessToken,
    });
    webhookSubscribed = sub.success;
    if (sub.warning) warnings.push(sub.warning);
  } else {
    warnings.push('WABA_ID_MISSING');
  }

  const reg = await registerPhoneNumber({
    phoneNumberId: params.phoneNumberId,
    accessToken: params.accessToken,
    pin: params.registrationPin,
  });
  const phoneRegistered = reg.success;
  if (reg.warning) warnings.push(reg.warning);

  return {
    tokenValidated,
    webhookSubscribed,
    phoneRegistered,
    setupWarnings: warnings,
    lastSetupCheckAt: new Date().toISOString(),
  };
}
