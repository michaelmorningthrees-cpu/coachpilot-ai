/**
 * OpenRouter-backed intent parser for CoachPilot AI scheduling.
 *
 * Takes a raw WhatsApp message (Cantonese / Traditional Chinese / English /
 * HK-mixed) and returns a strict, validated {@link IntentResult}. The model is
 * routed through OpenRouter (DeepSeek by default) using the OpenAI-compatible
 * SDK and instructed to emit JSON only.
 *
 * This module is side-effect free on import: the client is created lazily so
 * the server can boot (and other steps run) without an API key.
 */

import OpenAI from 'openai';
import { DateTime } from 'luxon';
import { logger } from './logger';
import {
  IntentResult,
  SchedulingIntent,
  SCHEDULING_INTENTS,
} from '../types/intent';
import { DEFAULT_TIMEZONE } from '../config/googleAuth';

// Provider: OpenRouter (OpenAI-compatible). Model: DeepSeek by default.
const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
const MODEL = process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-chat';

const SYSTEM_PROMPT = `You are CoachPilot AI, the message-understanding layer for a sports coach's WhatsApp assistant.
Read ONE WhatsApp message and classify it. Support Cantonese, Traditional Chinese, English, and HK mixed language.
Return JSON only. No markdown. No explanation.

Intents (use these EXACT strings):
- "greeting": a greeting or small talk with no scheduling content. Examples: "hello", "hi", "你好", "early", "在嗎".
- "new_booking": the user wants to book/train but has NOT given a concrete day AND time yet. Examples: "我想book", "book堂", "想訓練", "想約堂".
- "provide_datetime": the user is giving a concrete day and/or time (often answering "when?"). Examples: "3/7 8pm", "星期三晚上8點", "聽日7點", "下星期一 6-7pm".
- "check_my_booking": the user is asking about THEIR existing booking. Examples: "我宜家book左邊日", "我book咗邊日", "我有冇預約", "查預約", "我約咗幾時".
- "cancel_booking": the user wants to cancel an existing booking. Examples: "我想取消", "取消預約", "唔嚟了", "唔約喇", "cancel".
- "reschedule_booking": the user wants to change/move an existing booking. Examples: "改時間", "改期", "可唔可以改去星期四", "reschedule".
- "faq": a general question about price, location, duration, etc. Examples: "幾錢", "喺邊度", "幾耐一堂".
- "unknown": anything else, or you genuinely cannot tell.

Disambiguation:
- If the message asks WHICH day/time the user already booked (contains 邊日/幾時/有冇 with book/預約/約), it is "check_my_booking", NOT "new_booking".
- If the message contains a concrete day/time, prefer "provide_datetime" (unless it is clearly a cancel/reschedule/check).
- A bare greeting is NEVER a booking.

Date/time extraction:
- "date":
  - Relative days stay as concise English words: 聽日 -> "tomorrow", 今日 -> "today", 後日 -> "day after tomorrow", 星期三 -> "Wednesday", 下星期一 -> "next Monday".
  - A SPECIFIC calendar date MUST be ISO "YYYY-MM-DD" using the CURRENT DATE given below. Treat ambiguous numeric dates as DAY/MONTH (Hong Kong): "3/7" -> "2026-07-03", "7月3日" -> "2026-07-03", "Jul 3" -> "2026-07-03".
  - null when no date is mentioned.
- "time": short English string (e.g. "7pm", "8-9pm", "evening", "morning"); null when not mentioned.
- "confidence": 0.0–1.0 for your classification.
- "raw_message": the original, unmodified user message.

Output JSON (and nothing else):
{
  "intent": "greeting | new_booking | provide_datetime | check_my_booking | cancel_booking | reschedule_booking | faq | unknown",
  "date": string | null,
  "time": string | null,
  "confidence": number,
  "raw_message": string
}`;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (client) {
    return client;
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. Configure it in your environment to use the intent parser.',
    );
  }
  client = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL });
  return client;
}

function isSchedulingIntent(value: unknown): value is SchedulingIntent {
  return (
    typeof value === 'string' &&
    SCHEDULING_INTENTS.includes(value as SchedulingIntent)
  );
}

/**
 * Coerces an optional free-text field into a trimmed string or undefined.
 */
function normaliseOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Validates and normalises a raw parsed object into an IntentResult.
 * Returns null when the payload cannot be trusted (e.g. unknown intent).
 */
function validateIntentPayload(
  payload: unknown,
  originalMessage: string,
): IntentResult | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const candidate = payload as Record<string, unknown>;

  if (!isSchedulingIntent(candidate.intent)) {
    return null;
  }

  return {
    intent: candidate.intent,
    date: normaliseOptionalString(candidate.date),
    time: normaliseOptionalString(candidate.time),
    confidence: clampConfidence(candidate.confidence),
    // Trust our own copy of the message rather than the model echo.
    raw_message: originalMessage,
  };
}

/**
 * Safe fallback used when the model is unavailable or returns garbage.
 * Returns the "unknown" intent with zero confidence so downstream routing
 * knows the classification is untrusted and can respond gracefully.
 */
function fallbackResult(originalMessage: string): IntentResult {
  return {
    intent: 'unknown',
    confidence: 0,
    raw_message: originalMessage,
  };
}

/**
 * Robustly cleans a model response down to a parseable JSON string.
 *
 * Handles common DeepSeek/OpenRouter quirks:
 *   - markdown code fences (```json ... ``` or ``` ... ```)
 *   - leading/trailing prose around the JSON object
 *   - stray whitespace
 *
 * Strategy: remove any code fences, then slice from the first "{" to the last
 * "}" so surrounding text cannot break JSON.parse.
 */
function cleanJsonResponse(content: string): string {
  // Remove all markdown code-fence markers (opening ```json / ``` and closing).
  const withoutFences = content.replace(/```(?:json)?/gi, '').trim();

  const firstBrace = withoutFences.indexOf('{');
  const lastBrace = withoutFences.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return withoutFences.slice(firstBrace, lastBrace + 1).trim();
  }

  return withoutFences;
}

/**
 * Performs a single OpenRouter call and returns a validated IntentResult,
 * or null if the call/validation fails.
 */
async function requestIntent(message: string): Promise<IntentResult | null> {
  logger.info(`[OPENROUTER REQUEST] model=${MODEL} message="${message}"`);

  // Give the model the current date so it can resolve concrete dates like
  // "3/7" or "7月3日" to ISO, and relative ones like "tomorrow" correctly.
  const now = DateTime.now().setZone(DEFAULT_TIMEZONE);
  const dateContext = `CURRENT DATE: ${now.toFormat('yyyy-MM-dd')} (${now.toFormat('cccc')}), timezone ${DEFAULT_TIMEZONE}.`;

  const completion = await getClient().chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: dateContext },
      { role: 'user', content: message },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  logger.info(`[OPENROUTER RESPONSE] ${content ?? '(empty)'}`);

  if (!content) {
    logger.warn('OpenRouter returned an empty intent response.');
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanJsonResponse(content));
  } catch {
    logger.warn('OpenRouter intent response was not valid JSON.', content);
    return null;
  }

  return validateIntentPayload(parsed, message);
}

/**
 * Parses a WhatsApp message into a structured scheduling intent.
 *
 * Strategy: try once, retry once on failure, then fall back to a safe default.
 * Always resolves to a valid IntentResult — never throws.
 */
export async function parseIntent(message: string): Promise<IntentResult> {
  const trimmed = message?.trim() ?? '';
  if (trimmed.length === 0) {
    return fallbackResult(message ?? '');
  }

  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await requestIntent(trimmed);
      if (result) {
        logger.info(
          `[INTENT] message="${trimmed}" intent=${result.intent} confidence=${result.confidence} date=${result.date ?? 'null'} time=${result.time ?? 'null'}`,
        );
        return result;
      }
      logger.warn(
        `Intent parsing attempt ${attempt}/${maxAttempts} produced an invalid result.`,
      );
    } catch (error) {
      // A missing API key is a configuration error — surface it clearly.
      if (
        attempt === 1 &&
        error instanceof Error &&
        error.message.includes('OPENROUTER_API_KEY')
      ) {
        throw error;
      }
      logger.error(
        `Intent parsing attempt ${attempt}/${maxAttempts} failed.`,
        error,
      );
    }
  }

  logger.warn('[INTENT PARSED] Falling back to safe "unknown" intent.');
  return fallbackResult(trimmed);
}
