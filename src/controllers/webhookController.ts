/**
 * Express request handlers for the WhatsApp webhook.
 * Controllers stay thin: they orchestrate validation/parsing helpers
 * and translate results into HTTP responses.
 */

import { Request, Response } from 'express';
import { logger, maskPhone } from '../services/logger';
import { verifyWebhook } from '../utils/validateWebhook';
import {
  verifyMetaSignature,
  isUnsignedWebhookAllowed,
} from '../utils/verifySignature';
import { DateTime } from 'luxon';
import { WebhookVerificationQuery, WhatsAppWebhookBody } from '../types/whatsapp';
import { parseIntent } from '../services/openaiIntentParser';
import {
  checkAvailability,
  createBooking,
  buildBookingEventTitle,
  getCalendarClientForCoach,
} from '../services/googleCalendarService';
import { sendWhatsAppMessage } from '../services/whatsappService';
import { resolveSlot } from '../services/dateTimeResolver';
import {
  isWithinWorkingHours,
  describeWorkingWindow,
} from '../services/coachConfigService';
import { DEFAULT_TIMEZONE } from '../config/googleAuth';
import {
  detectLanguage,
  getContext,
  updateContext,
  clearLastSuggestedSlot,
} from '../services/conversationContextService';
import {
  isDuplicateMessage,
  markMessageProcessed,
} from '../services/webhookIdempotencyService';
import { resolveCoachForWebhook } from '../services/coachResolverService';
import { getFaqReply } from '../services/faqService';
import { Coach } from '../types/coach';

/**
 * Resolves the webhook verify token at request time (never cached at module
 * load, so it always reflects the current environment). Prefers the canonical
 * WEBHOOK_VERIFY_TOKEN and falls back to the legacy WHATSAPP_VERIFY_TOKEN so
 * existing deployments keep working.
 */
export function getVerifyToken(): string {
  return (
    process.env.WEBHOOK_VERIFY_TOKEN ??
    process.env.WHATSAPP_VERIFY_TOKEN ??
    ''
  );
}

/**
 * GET /webhook — Meta webhook verification handshake.
 */
export function handleVerification(req: Request, res: Response): void {
  try {
    const query = req.query as WebhookVerificationQuery;
    const expectedToken = getVerifyToken();
    const result = verifyWebhook(query, expectedToken);

    if (result.verified && result.challenge) {
      logger.info('Webhook verification succeeded.');
      res.status(200).send(result.challenge);
      return;
    }

    // Diagnostic that never leaks the secret value — only booleans/lengths.
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    logger.warn(
      '[WEBHOOK VERIFY] Failed (mode/token mismatch). ' +
        `mode=${mode ?? 'none'} ` +
        `modeOk=${mode === 'subscribe'} ` +
        `expectedConfigured=${expectedToken ? 'yes' : 'no'} ` +
        `tokenProvided=${token ? 'yes' : 'no'} ` +
        `tokenMatches=${Boolean(expectedToken) && token === expectedToken} ` +
        `challengePresent=${challenge ? 'yes' : 'no'}`,
    );
    res.sendStatus(403);
  } catch (error) {
    logger.error('Unexpected error during webhook verification.', error);
    res.sendStatus(500);
  }
}

/**
 * POST /webhook — receive incoming WhatsApp events.
 * Always responds 200 quickly so Meta does not retry; parsing problems
 * are logged rather than surfaced as errors to the platform.
 */
export function handleIncomingEvent(req: Request, res: Response): void {
  try {
    // 1) Verify Meta's signature over the RAW body before trusting anything.
    const signatureValid = verifyMetaSignature(
      req.rawBody,
      req.header('x-hub-signature-256'),
      process.env.WHATSAPP_APP_SECRET,
    );

    if (!signatureValid) {
      if (isUnsignedWebhookAllowed()) {
        logger.warn(
          '[WEBHOOK] Unsigned request accepted via development bypass (ALLOW_UNSIGNED_WEBHOOKS=true).',
        );
      } else {
        logger.warn('[WEBHOOK] Rejected: invalid or missing X-Hub-Signature-256.');
        res.sendStatus(403);
        return;
      }
    }

    const body = req.body as WhatsAppWebhookBody | undefined;

    // Works for BOTH real Meta payloads and simplified local/curl payloads:
    // as long as the first message can be reached, it is valid.
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message) {
      logger.warn('Received webhook POST with unexpected payload shape.', body);
      res.sendStatus(200);
      return;
    }

    const from = message.from;
    const text = message.text?.body;
    const timestamp = message.timestamp;
    // Meta provides a stable message id; absent in simplified local/curl tests.
    const messageId = message.id;
    // Routes the message to a coach. Absent in simplified local/curl tests
    // (then we fall back to DEFAULT_COACH_ID).
    const phoneNumberId = value?.metadata?.phone_number_id;

    // Acknowledge to Meta immediately, then process in the background so a slow
    // AI/calendar call never delays the webhook ACK.
    res.sendStatus(200);

    void processIncomingMessage({ phoneNumberId, messageId, from, text, timestamp });
  } catch (error) {
    logger.error('Unexpected error while handling incoming webhook event.', error);
    // Still acknowledge so Meta does not aggressively retry on our bug.
    if (!res.headersSent) {
      res.sendStatus(200);
    }
  }
}

/**
 * Formats a 1-hour slot starting at `startISO` as "Sunday 7–8pm".
 */
function formatSlotLabel(
  startISO: string,
  timezone: string = DEFAULT_TIMEZONE,
): string {
  const start = DateTime.fromISO(startISO, { zone: timezone });
  const end = start.plus({ hours: 1 });

  const label = (dt: DateTime): string => {
    const hour12 = dt.hour % 12 === 0 ? 12 : dt.hour % 12;
    const minute = dt.minute === 0 ? '' : `:${String(dt.minute).padStart(2, '0')}`;
    const meridiem = dt.hour < 12 ? 'am' : 'pm';
    return `${hour12}${minute}${meridiem}`;
  };

  const sameMeridiem = start.hour < 12 === end.hour < 12;
  const range = sameMeridiem
    ? `${label(start).replace(/(am|pm)$/, '')}–${label(end)}`
    : `${label(start)}–${label(end)}`;

  return `${start.toFormat('cccc')} ${range}`;
}

/**
 * Formats a 1-hour slot in Chinese, e.g. "星期日晚上7–8點".
 */
function formatSlotLabelZh(
  startISO: string,
  timezone: string = DEFAULT_TIMEZONE,
): string {
  const start = DateTime.fromISO(startISO, { zone: timezone });
  const end = start.plus({ hours: 1 });

  // Luxon weekday: 1=Mon .. 7=Sun.
  const weekdayZh = ['一', '二', '三', '四', '五', '六', '日'][start.weekday - 1];
  const period =
    start.hour < 6
      ? '凌晨'
      : start.hour < 12
        ? '上午'
        : start.hour < 18
          ? '下午'
          : '晚上';
  const to12 = (hour: number): number => (hour % 12 === 0 ? 12 : hour % 12);

  return `星期${weekdayZh}${period}${to12(start.hour)}–${to12(end.hour)}點`;
}

/**
 * Simplified MVP flow for a single incoming message:
 *   parseIntent → (check_availability) build ISO range → checkAvailability →
 *   build a short reply → console-log the outgoing reply.
 *
 * For now we do NOT send a real WhatsApp message and do NOT create bookings.
 * Never throws.
 */
interface IncomingMessage {
  phoneNumberId: string | undefined;
  messageId: string | undefined;
  from: string;
  text: string | undefined;
  timestamp: string | undefined;
}

async function processIncomingMessage(msg: IncomingMessage): Promise<void> {
  const { phoneNumberId, messageId, from, text, timestamp } = msg;

  logger.incomingMessage({
    from,
    text: text ?? '',
    timestamp: timestamp ?? new Date().toISOString(),
  });

  // Resolve which coach this message belongs to (phoneNumberId → coach, or
  // DEFAULT_COACH_ID for local curl). Bail out clearly if none is found.
  const coach = await resolveCoachForWebhook(phoneNumberId);
  if (!coach) {
    logger.error(
      '[COACH RESOLVER] Could not resolve a coach for this message; aborting.',
    );
    return;
  }
  logger.info(`[COACH] Resolved coachId=${coach.coachId} (${coach.sport}).`);

  // Idempotency: skip messages we have already accepted (Meta retries, etc.).
  if (await isDuplicateMessage(coach.coachId, messageId, from, timestamp, text)) {
    logger.info(
      `[DUPLICATE WEBHOOK SKIPPED] coach=${coach.coachId} from=${maskPhone(from)}`,
    );
    return;
  }
  // Mark as accepted up front so concurrent retries are deduped immediately.
  await markMessageProcessed(coach.coachId, messageId, from, timestamp, text);

  if (!text) {
    logger.info('Incoming message has no text body; nothing to process.');
    return;
  }

  const language = detectLanguage(text);
  logger.info(`[LANGUAGE DETECTED] phone=${maskPhone(from)} language=${language}`);

  try {
    const intent = await parseIntent(text);

    const reply = await buildReply(coach, intent, from, text, language);

    // Always log the outgoing reply, regardless of the feature flag.
    logger.outgoingMessage(from, reply);

    // Feature flag: gate real Meta WhatsApp sends behind ENABLE_REAL_WHATSAPP.
    // Uses the coach's own WhatsApp credentials (env is only a local fallback).
    if (process.env.ENABLE_REAL_WHATSAPP === 'true') {
      try {
        await sendWhatsAppMessage({
          phoneNumberId: coach.whatsapp.phoneNumberId,
          accessToken: coach.whatsapp.accessToken,
          to: from,
          message: reply,
        });
        logger.info('[REAL WHATSAPP SENT]');
      } catch (error) {
        // A send failure must never crash the webhook flow — log and continue.
        logger.error('[WHATSAPP SEND FAILED]', error);
      }
    } else {
      logger.info(
        '[REAL WHATSAPP DISABLED] (set ENABLE_REAL_WHATSAPP=true to send via Meta)',
      );
    }
  } catch (error) {
    logger.error('Failed to process incoming message flow.', error);
  }
}

/**
 * Detects a short affirmative ("yes", "ok", "好", "可以", "book it"…). Only
 * meaningful when a slot was previously suggested — it turns a one-word reply
 * into a confirmation to book the pending slot.
 */
function isConfirmation(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (
    /^(y|yes|yep|yeah|ya|ok|okay|k|sure|confirm|book|book it|go|go ahead|please|sounds good|deal|great|perfect)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // Cantonese / Traditional Chinese affirmatives.
  return /(好|可以|得|冇問題|沒問題|要呀|要啦|係|訂|預約|confirm|ok)/.test(text);
}

/**
 * "Which day and time?" prompt used when we cannot resolve a concrete slot.
 */
function askForDayTime(language: 'zh' | 'en'): string {
  return language === 'zh'
    ? '可以 👍 想預約邊一日同幾點？例如「星期三晚上8點」'
    : 'Sure 👍 which day and time? e.g. "Wednesday 8pm"';
}

/**
 * Creates the calendar event for a concrete slot and returns a confirmation
 * reply. Clears the pending suggested slot on success.
 */
async function bookSlot(
  coach: Coach,
  from: string,
  startISO: string,
  endISO: string,
  label: { en: string; zh: string },
  language: 'zh' | 'en',
): Promise<string> {
  logger.info(
    `[BOOKING ATTEMPT] coach=${coach.coachId} phone=${maskPhone(from)} slot=${startISO}`,
  );
  const booking = await createBooking(
    startISO,
    endISO,
    from,
    coach.calendar.calendarId,
    buildBookingEventTitle(coach),
    getCalendarClientForCoach(coach),
  );

  if (booking.success) {
    await clearLastSuggestedSlot(coach.coachId, from);
    await updateContext(coach.coachId, from, {
      lastIntent: 'create_booking',
      language,
    });
    return language === 'zh'
      ? `完成 👍 已幫你預約${label.zh} 🏀 到時見！`
      : `Done 👍 booked you for ${label.en} 🏀 see you!`;
  }

  return language === 'zh'
    ? 'Ah 嗰個時段啱啱俾人訂咗 😅 試下第個時間？'
    : 'Ah that slot just got taken 😅 want another time?';
}

/**
 * Builds the student-facing reply for a parsed intent, using the coach's
 * timezone, working hours, calendar and FAQ. Conversation context is keyed by
 * (coachId, student phone).
 */
async function buildReply(
  coach: Coach,
  intent: Awaited<ReturnType<typeof parseIntent>>,
  from: string,
  text: string,
  language: 'zh' | 'en',
): Promise<string> {
  const calendarId = coach.calendar.calendarId;
  const calendarClient = getCalendarClientForCoach(coach);
  const context = await getContext(coach.coachId, from);

  // Keep the language stable across a conversation: a Han character forces
  // Chinese, but an English/numeric-only follow-up (e.g. "3/7 8pm", "ok")
  // inherits whatever language the conversation has been using so replies
  // don't flip-flop between English and Cantonese.
  const lang: 'zh' | 'en' = /[\u4e00-\u9fff]/.test(text)
    ? 'zh'
    : (context?.language ?? language);

  // A concrete slot the student named *in this message* (e.g. "Wednesday 8pm").
  const requestedSlot = resolveSlot(
    intent.date,
    intent.time,
    undefined,
    coach.timezone,
  );

  // 1) The student named a specific time — either asking if it is free
  //    (check_availability) or asking to book it (create_booking).
  if (
    requestedSlot &&
    (intent.intent === 'check_availability' ||
      intent.intent === 'create_booking')
  ) {
    const { startISO, endISO } = requestedSlot;

    if (
      !isWithinWorkingHours(coach.workingHours, coach.timezone, startISO, endISO)
    ) {
      logger.info(
        `[WORKING HOURS] Rejected out-of-hours request coach=${coach.coachId} slot=${startISO}`,
      );
      return describeWorkingWindow(
        coach.workingHours,
        coach.timezone,
        startISO,
        lang,
      );
    }

    const result = await checkAvailability(
      startISO,
      endISO,
      calendarId,
      calendarClient,
    );

    if (!result.available) {
      await updateContext(coach.coachId, from, {
        lastIntent: intent.intent,
        language: lang,
      });
      return lang === 'zh'
        ? '嗰個時段滿咗 😅 要唔要睇下第個時間？'
        : 'That time looks full 😅 want me to check another time?';
    }

    const displayTextEn = formatSlotLabel(startISO, coach.timezone);
    const displayTextZh = formatSlotLabelZh(startISO, coach.timezone);

    // The student explicitly asked to book → just do it (no extra round-trip).
    if (intent.intent === 'create_booking') {
      return bookSlot(
        coach,
        from,
        startISO,
        endISO,
        { en: displayTextEn, zh: displayTextZh },
        lang,
      );
    }

    // Availability question → remember the slot and offer to book it.
    await updateContext(coach.coachId, from, {
      lastIntent: 'check_availability',
      lastSuggestedSlot: { startISO, endISO, displayTextEn, displayTextZh },
      language: lang,
    });
    logger.info(
      `[CONTEXT SAVED] coach=${coach.coachId} phone=${maskPhone(from)} slot=${startISO}`,
    );
    return lang === 'zh'
      ? `${displayTextZh}有位 👍 要幫你預約嗎？`
      : `${displayTextEn} is available 👍 want me to book it?`;
  }

  // 2) The student is confirming a slot we already suggested (e.g. "yes" /
  //    "好" / "book it" / a bare create_booking with no new time).
  if (
    context?.lastSuggestedSlot &&
    (intent.intent === 'create_booking' || isConfirmation(text))
  ) {
    const slot = context.lastSuggestedSlot;
    logger.info(
      `[CONTEXT USED] coach=${coach.coachId} phone=${maskPhone(from)} slot=${slot.startISO}`,
    );
    return bookSlot(
      coach,
      from,
      slot.startISO,
      slot.endISO,
      { en: slot.displayTextEn, zh: slot.displayTextZh },
      lang,
    );
  }

  // 3) Scheduling intent but no resolvable time and nothing pending → ask.
  if (
    intent.intent === 'check_availability' ||
    intent.intent === 'create_booking'
  ) {
    return askForDayTime(lang);
  }

  // 4) Reschedule → keep it simple for the MVP: ask for the new time.
  if (intent.intent === 'reschedule_request') {
    return lang === 'zh'
      ? '冇問題 👍 想改去邊一日同幾點？'
      : 'No problem 👍 which day and time would you like to move it to?';
  }

  // 5) Unknown intent → try FAQ/pricing, else a friendly nudge.
  const faqReply = getFaqReply(coach, text, lang);
  if (faqReply) {
    logger.info(`[FAQ] Answered unknown intent for coach=${coach.coachId}.`);
    return faqReply;
  }
  return lang === 'zh'
    ? '收到 👍 想預約邊一日同幾點？'
    : 'Got it 👍 when would you like to train?';
}
