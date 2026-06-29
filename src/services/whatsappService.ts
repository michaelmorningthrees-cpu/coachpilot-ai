/**
 * WhatsApp Cloud API sender (text messages only, MVP).
 *
 * Sends a plain text message via the Graph API `/messages` endpoint.
 *
 * THROWS on failure (missing credentials, non-2xx Meta response, network
 * error). The caller (webhookController) wraps this in try/catch so a send
 * failure is logged but never crashes the webhook flow. Throwing — rather than
 * swallowing — lets the caller distinguish a real success ([REAL WHATSAPP SENT])
 * from a failure ([WHATSAPP SEND FAILED]).
 *
 * Per-coach credentials are passed in (phoneNumberId + accessToken). For local
 * development, callers may omit them and we fall back to env
 * (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TOKEN).
 *
 * Environment variables (local fallback only):
 *   - WHATSAPP_TOKEN
 *   - WHATSAPP_PHONE_NUMBER_ID
 *   - WHATSAPP_API_VERSION (optional, defaults to v22.0)
 */

import { logger } from './logger';

const API_VERSION = process.env.WHATSAPP_API_VERSION ?? 'v22.0';

export interface WhatsAppSendResponse {
  messaging_product?: string;
  contacts?: Array<{ input?: string; wa_id?: string }>;
  messages?: Array<{ id?: string }>;
}

export interface SendWhatsAppMessageParams {
  /** Coach's WhatsApp Business phone number id (sender). */
  phoneNumberId?: string;
  /** Coach's WhatsApp access token. */
  accessToken?: string;
  /** Recipient phone number. */
  to: string;
  /** Message body. */
  message: string;
}

/**
 * Sends a text message to a WhatsApp user using the given coach credentials
 * (falling back to env for local dev). Resolves with the full Meta API response
 * object on success; throws on any failure.
 */
export async function sendWhatsAppMessage(
  params: SendWhatsAppMessageParams,
): Promise<WhatsAppSendResponse> {
  const token = params.accessToken ?? process.env.WHATSAPP_TOKEN;
  const phoneNumberId =
    params.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
  const { to, message } = params;

  if (!token || !phoneNumberId) {
    throw new Error(
      'Missing WhatsApp credentials (phoneNumberId/accessToken or env fallback).',
    );
  }

  const url = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: false, body: message },
    }),
  });

  const rawBody = await response.text();

  if (!response.ok) {
    // Log the full Meta error response, then throw so the caller can react.
    logger.error(
      `[WHATSAPP SEND FAILED] status=${response.status} response=${rawBody}`,
    );
    throw new Error(
      `Meta API error: status ${response.status} response ${rawBody}`,
    );
  }

  const data = JSON.parse(rawBody) as WhatsAppSendResponse;
  logger.info(
    `[WHATSAPP SEND SUCCESS] status=${response.status} response=${rawBody}`,
  );
  return data;
}
