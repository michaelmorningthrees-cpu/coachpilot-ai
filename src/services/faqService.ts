/**
 * Lightweight FAQ / pricing responder.
 *
 * When the intent parser returns "unknown", we do a simple keyword check
 * against the message and answer from the coach's faq/pricing data. Kept
 * intentionally simple — no NLP, just keyword matching in EN + zh/Cantonese.
 */

import { Coach } from '../types/coach';

const PRICE_PATTERN = /price|pricing|cost|how much|fee|rate|幾錢|收費|價錢|價格|幾多錢/i;
const VENUE_PATTERN = /venue|where|location|address|地點|邊度|喺邊|地址|場地/i;
const DURATION_PATTERN = /how long|duration|length|幾耐|幾長|時間幾耐|幾多個鐘/i;

/**
 * Returns an FAQ/pricing answer for the message, or null if nothing matches.
 */
export function getFaqReply(
  coach: Coach,
  message: string,
  language: 'zh' | 'en',
): string | null {
  if (PRICE_PATTERN.test(message)) {
    const pricingText = coach.pricing?.text;
    if (pricingText) {
      return pricingText;
    }
    if (coach.pricing?.perSession) {
      const currency = coach.pricing.currency ?? '';
      return language === 'zh'
        ? `每堂收費 ${currency}${coach.pricing.perSession} 💰`
        : `Each session is ${currency}${coach.pricing.perSession} 💰`;
    }
  }

  if (VENUE_PATTERN.test(message) && coach.faq?.venue) {
    return coach.faq.venue;
  }

  if (DURATION_PATTERN.test(message) && coach.faq?.duration) {
    return coach.faq.duration;
  }

  return null;
}
