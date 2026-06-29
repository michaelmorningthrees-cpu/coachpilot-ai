/**
 * Minimal type definitions for the Meta WhatsApp Cloud API webhook payload.
 * Only the fields required for Step 1 (message receiving) are modelled here.
 * See: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 *
 * Fields that simplified local/curl test payloads may omit (id, timestamp,
 * type, object, ...) are optional so both payload shapes type-check.
 */

export interface WhatsAppTextBody {
  body: string;
}

export interface WhatsAppMessage {
  from: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: WhatsAppTextBody;
}

export interface WhatsAppContactProfile {
  name: string;
}

export interface WhatsAppContact {
  profile?: WhatsAppContactProfile;
  wa_id: string;
}

export interface WhatsAppMetadata {
  /** The WhatsApp Business phone number ID that received the message. */
  phone_number_id?: string;
  display_phone_number?: string;
}

export interface WhatsAppValue {
  messaging_product?: string;
  metadata?: WhatsAppMetadata;
  contacts?: WhatsAppContact[];
  messages?: WhatsAppMessage[];
}

export interface WhatsAppChange {
  field?: string;
  value: WhatsAppValue;
}

export interface WhatsAppEntry {
  id?: string;
  changes: WhatsAppChange[];
}

export interface WhatsAppWebhookBody {
  object?: string;
  entry: WhatsAppEntry[];
}

/**
 * Normalised representation of a single incoming message,
 * extracted from the raw webhook payload for easy logging/handling.
 */
export interface ParsedIncomingMessage {
  from: string;
  text: string;
  timestamp: string;
}

/**
 * Query parameters Meta sends on the GET verification request.
 */
export interface WebhookVerificationQuery {
  'hub.mode'?: string;
  'hub.verify_token'?: string;
  'hub.challenge'?: string;
}
