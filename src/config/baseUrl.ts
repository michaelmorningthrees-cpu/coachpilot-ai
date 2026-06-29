/**
 * Centralized public base URL resolution for callback links.
 *
 * All externally-reachable callbacks (Meta webhook, Google OAuth, WhatsApp
 * Embedded Signup) are derived from BASE_URL so the app works identically on
 * localhost and on Render without hardcoding hosts.
 *
 *   - BASE_URL set            → used as-is (trailing slash stripped)
 *   - BASE_URL missing (dev)  → http://localhost:<PORT>
 *   - BASE_URL missing (prod) → throws (fail fast)
 */

/** Returns the configured public base URL, e.g. https://coachpilot-ai.onrender.com. */
export function getBaseUrl(): string {
  const explicit = process.env.BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }

  const isProduction = (process.env.NODE_ENV ?? 'development') === 'production';
  if (isProduction) {
    throw new Error(
      'Refusing to start: BASE_URL is required in production ' +
        '(e.g. https://coachpilot-ai.onrender.com).',
    );
  }

  const port = Number(process.env.PORT ?? 3001);
  return `http://localhost:${port}`;
}

/**
 * Google OAuth redirect URI. An explicit GOOGLE_OAUTH_REDIRECT_URI wins;
 * otherwise it is derived from BASE_URL.
 */
export function getGoogleRedirectUri(): string {
  const explicit = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (explicit) {
    return explicit;
  }
  return `${getBaseUrl()}/oauth/google/callback`;
}

/** Public Meta webhook callback URL. */
export function getWebhookCallbackUrl(): string {
  return `${getBaseUrl()}/webhook`;
}

/** Public WhatsApp Embedded Signup callback URL. */
export function getEmbeddedSignupCallbackUrl(): string {
  return `${getBaseUrl()}/coach/whatsapp/embedded/callback`;
}
