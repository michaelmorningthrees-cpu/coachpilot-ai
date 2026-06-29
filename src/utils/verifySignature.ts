/**
 * Meta WhatsApp webhook signature verification.
 *
 * Meta signs every webhook POST with an HMAC-SHA256 of the RAW request body,
 * keyed by the app secret, sent in the `X-Hub-Signature-256` header as
 * `sha256=<hex>`. We must verify it against the exact bytes received.
 */

import crypto from 'crypto';

/**
 * Returns true only when `signatureHeader` matches the HMAC-SHA256 of
 * `rawBody` computed with `appSecret`. Uses a constant-time comparison.
 */
export function verifyMetaSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  appSecret: string | undefined,
): boolean {
  if (!rawBody || !signatureHeader || !appSecret) {
    return false;
  }

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  const received = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expected);

  // Length check first — timingSafeEqual throws on length mismatch.
  if (received.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(received, expectedBuf);
}

/**
 * Whether unsigned webhooks are permitted. Only true in development with the
 * explicit ALLOW_UNSIGNED_WEBHOOKS=true flag, so local curl testing works
 * while production always requires a valid signature.
 */
export function isUnsignedWebhookAllowed(): boolean {
  return (
    process.env.NODE_ENV === 'development' &&
    process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true'
  );
}
