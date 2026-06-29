/**
 * Pure helper functions for webhook verification and payload parsing.
 * Kept free of Express/HTTP concerns so they are easy to unit test.
 */

import {
  ParsedIncomingMessage,
  WebhookVerificationQuery,
  WhatsAppWebhookBody,
  WhatsAppMessage,
} from '../types/whatsapp';

export interface VerificationResult {
  verified: boolean;
  challenge?: string;
}

/**
 * Validates a Meta webhook verification (GET) request.
 * Returns the challenge to echo back only when mode + token are correct.
 */
export function verifyWebhook(
  query: WebhookVerificationQuery,
  expectedToken: string,
): VerificationResult {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode === 'subscribe' && token === expectedToken && challenge) {
    return { verified: true, challenge };
  }

  return { verified: false };
}

/**
 * Converts a WhatsApp Unix timestamp (seconds, as string) into an ISO string.
 * Falls back to the current time if the value is missing or unparseable.
 */
function toIsoTimestamp(unixSeconds: string | undefined): string {
  if (!unixSeconds) {
    return new Date().toISOString();
  }

  const seconds = Number(unixSeconds);
  if (!Number.isFinite(seconds)) {
    return new Date().toISOString();
  }

  return new Date(seconds * 1000).toISOString();
}

function extractText(message: WhatsAppMessage): string | undefined {
  // Accept any message that carries a text body. We intentionally do NOT
  // require `type === 'text'` so simplified local/curl payloads (which often
  // omit `type`) still work, while real non-text messages (image/audio/etc.)
  // have no text.body and are skipped.
  if (message.text?.body) {
    return message.text.body;
  }
  return undefined;
}

/**
 * Type guard accepting any payload that contains an `entry` array.
 *
 * This deliberately supports BOTH:
 *   - real Meta WhatsApp Cloud API payloads (object === 'whatsapp_business_account')
 *   - simplified local/curl payloads (no `object`, no metadata/contacts/statuses)
 *
 * As long as `entry[].changes[].value.messages` can be reached, it is treated
 * as a valid incoming webhook body.
 */
export function isWhatsAppWebhookBody(
  body: unknown,
): body is WhatsAppWebhookBody {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const candidate = body as Partial<WhatsAppWebhookBody>;
  return Array.isArray(candidate.entry);
}

/**
 * Safely walks a webhook payload and returns every text message found.
 * Non-text messages and malformed entries are skipped silently.
 */
export function parseIncomingMessages(
  body: WhatsAppWebhookBody,
): ParsedIncomingMessage[] {
  const parsed: ParsedIncomingMessage[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const messages = change.value?.messages ?? [];
      for (const message of messages) {
        const text = extractText(message);
        if (!message.from || text === undefined) {
          continue;
        }
        parsed.push({
          from: message.from,
          text,
          timestamp: toIsoTimestamp(message.timestamp),
        });
      }
    }
  }

  return parsed;
}
