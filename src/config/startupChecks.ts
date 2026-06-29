/**
 * Startup safety checks run once before the server begins listening.
 *
 * - In production, refuses to start with an insecure webhook bypass enabled.
 * - Validates critical environment variables: fails fast in production,
 *   warns (and runs degraded) in non-production environments.
 */

import { logger } from '../services/logger';
import { getBaseUrl } from './baseUrl';

/**
 * Environment variables required for full production functionality.
 * Missing values cause a hard failure in production and a warning elsewhere.
 */
const CRITICAL_ENV_VARS = [
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_APP_SECRET',
  'OPENROUTER_API_KEY',
  'GOOGLE_CALENDAR_ID',
  'FIREBASE_PROJECT_ID',
] as const;

/**
 * Runs all startup checks. Throws to abort boot when an unsafe or unusable
 * configuration is detected in production.
 */
export function runStartupChecks(): void {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';

  // Never allow the unsigned-webhook bypass in production.
  if (isProduction && process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true') {
    throw new Error(
      'Refusing to start: ALLOW_UNSIGNED_WEBHOOKS=true is not permitted when ' +
        'NODE_ENV=production. Unset it or set it to false.',
    );
  }

  // In production, callback URLs must be a real https host (never localhost).
  if (isProduction) {
    const baseUrl = process.env.BASE_URL?.trim();
    if (!baseUrl) {
      throw new Error(
        'Refusing to start: BASE_URL is required in production ' +
          '(e.g. https://coachpilot-ai.onrender.com).',
      );
    }
    if (!baseUrl.startsWith('https://')) {
      throw new Error(
        `Refusing to start: BASE_URL must start with https:// in production (got "${baseUrl}").`,
      );
    }
    if (/localhost|127\.0\.0\.1/i.test(baseUrl)) {
      throw new Error(
        'Refusing to start: BASE_URL must not point to localhost in production.',
      );
    }

    const redirect = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
    if (redirect && /localhost|127\.0\.0\.1/i.test(redirect)) {
      throw new Error(
        'Refusing to start: GOOGLE_OAUTH_REDIRECT_URI must not point to localhost ' +
          'in production. Unset it to derive from BASE_URL.',
      );
    }
  }

  const missing = CRITICAL_ENV_VARS.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    if (isProduction) {
      throw new Error(
        `Refusing to start: missing required environment variables in ` +
          `production: ${missing.join(', ')}.`,
      );
    }
    logger.warn(
      `[STARTUP] Missing recommended env vars (NODE_ENV=${nodeEnv}): ` +
        `${missing.join(', ')}. Related features run in degraded mode until set.`,
    );
  } else {
    logger.info('[STARTUP] All critical environment variables are present.');
  }

  logger.info(`[STARTUP] Environment: ${nodeEnv}.`);
  logger.info(`[STARTUP] Base URL: ${getBaseUrl()}`);
}
