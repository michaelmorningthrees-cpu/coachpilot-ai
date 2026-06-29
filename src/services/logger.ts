/**
 * Lightweight console logger.
 * Centralises all logging so output format stays consistent and can later
 * be swapped for a structured logger (pino/winston) without touching callers.
 */

import { ParsedIncomingMessage } from '../types/whatsapp';

function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Masks a phone number so logs only reveal the last 4 digits, e.g.
 * "85291234567" → "*******4567". Non-digits are ignored for the mask.
 */
export function maskPhone(phone: string | undefined): string {
  if (!phone) {
    return 'unknown';
  }
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) {
    return '*'.repeat(Math.max(0, digits.length - 1)) + digits.slice(-1);
  }
  return '*'.repeat(digits.length - 4) + digits.slice(-4);
}

export const logger = {
  info(message: string, ...meta: unknown[]): void {
    console.log(`[INFO] ${timestamp()} ${message}`, ...meta);
  },

  warn(message: string, ...meta: unknown[]): void {
    console.warn(`[WARN] ${timestamp()} ${message}`, ...meta);
  },

  error(message: string, ...meta: unknown[]): void {
    console.error(`[ERROR] ${timestamp()} ${message}`, ...meta);
  },

  /**
   * Pretty-prints an incoming WhatsApp message in the required format.
   */
  incomingMessage(message: ParsedIncomingMessage): void {
    const lines = [
      '[WHATSAPP INCOMING]',
      `From: ${maskPhone(message.from)}`,
      `Message: "${message.text}"`,
      `Time: ${message.timestamp}`,
    ];
    console.log(lines.join('\n'));
  },

  /**
   * Pretty-prints an outgoing WhatsApp message in the required format.
   */
  outgoingMessage(to: string, message: string): void {
    const lines = [
      '[WHATSAPP OUTGOING]',
      `To: ${maskPhone(to)}`,
      `Message: "${message}"`,
    ];
    console.log(lines.join('\n'));
  },
};
