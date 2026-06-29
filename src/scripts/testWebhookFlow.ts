/**
 * End-to-end webhook flow driver (local, dev-bypass).
 *
 * Sends a series of simulated WhatsApp messages to the running local server and
 * lets you watch the server logs for the results. Each message gets a unique id
 * and timestamp so idempotency never blocks reruns; dependent steps wait a few
 * seconds so the async AI → calendar → Firestore pipeline can finish.
 *
 * Prerequisites:
 *   - Server running locally:  npm run dev
 *   - NODE_ENV=development and ALLOW_UNSIGNED_WEBHOOKS=true in .env
 *     (so unsigned curl-style requests are accepted)
 *
 * Run with:  npx ts-node src/scripts/testWebhookFlow.ts
 *       or:  npm run test:flow
 *
 * Optional env:
 *   WEBHOOK_BASE_URL  (default http://localhost:<PORT>/webhook)
 *   PORT              (default 3001)
 *   STEP_DELAY_MS     (default 9000) wait between dependent steps
 *   FROM              (default 85291234567) the simulated student phone
 */

import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT ?? '3001';
const BASE_URL =
  process.env.WEBHOOK_BASE_URL ?? `http://localhost:${PORT}/webhook`;
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS ?? 9000);
const FROM = process.env.FROM ?? '85291234567';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let seq = 0;
function uniqueId(): string {
  seq += 1;
  return `wamid.test_${Date.now()}_${seq}`;
}

interface SendOptions {
  /** Reuse a specific message id (e.g. to test duplicate detection). */
  id?: string;
}

async function send(
  label: string,
  text: string,
  expected: string,
  options: SendOptions = {},
): Promise<void> {
  const id = options.id ?? uniqueId();
  const timestamp = String(Math.floor(Date.now() / 1000));

  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { from: FROM, id, text: { body: text }, timestamp },
              ],
            },
          },
        ],
      },
    ],
  };

  process.stdout.write(`\n▶ ${label}\n  send: "${text}"  (id=${id})\n`);

  try {
    const res = await fetch(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    process.stdout.write(`  ack:  HTTP ${res.status}\n`);
  } catch (error) {
    process.stdout.write(
      `  ❌ request failed: ${error instanceof Error ? error.message : String(error)}\n` +
        `     Is the server running? (npm run dev)\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`  expect (in server logs): ${expected}\n`);
}

async function main(): Promise<void> {
  console.log(`[FLOW] Target: ${BASE_URL}`);
  console.log(`[FLOW] Watch your "npm run dev" terminal for the results.\n`);

  // --- Scenario 1: English happy path -------------------------------------
  console.log('=== Scenario 1: English happy path ===');
  const s1FirstId = uniqueId();
  await send(
    '1a. Ask availability',
    'Monday 7pm available?',
    '[CONTEXT FIRESTORE SAVED] + reply "Monday 7–8pm is available 👍"',
    { id: s1FirstId },
  );
  await sleep(STEP_DELAY_MS);
  await send(
    '1b. Confirm booking',
    'ok book it',
    '[CONTEXT USED] → "Booking created" → reply "Done 👍 booked you for Monday 7–8pm 🏀"',
  );
  await sleep(STEP_DELAY_MS);

  // --- Scenario 2: Duplicate webhook --------------------------------------
  console.log('\n=== Scenario 2: Duplicate webhook (reuse id from 1a) ===');
  await send(
    '2. Resend 1a',
    'Monday 7pm available?',
    '[DUPLICATE WEBHOOK SKIPPED] (no re-processing)',
    { id: s1FirstId },
  );
  await sleep(2000);

  // --- Scenario 3: Outside working hours ----------------------------------
  console.log('\n=== Scenario 3: Outside working hours ===');
  await send(
    '3. Ask 11am (outside 18:00–22:00)',
    'Monday 11am available?',
    '[WORKING HOURS] Rejected → reply with working window (no calendar call)',
  );
  await sleep(STEP_DELAY_MS);

  // --- Scenario 4: Vague request → clarification --------------------------
  console.log('\n=== Scenario 4: Vague → clarification ===');
  await send(
    '4. No time given',
    'I want to book a session',
    'reply asks for day/time, e.g. \'which day and time?\'',
  );
  await sleep(STEP_DELAY_MS);

  // --- Scenario 5: Cantonese happy path -----------------------------------
  console.log('\n=== Scenario 5: Cantonese happy path ===');
  await send(
    '5a. 查詢 (Cantonese)',
    '星期五夜晚9點有冇位？',
    'language=zh → reply "星期五晚上9–10點有位 👍 要幫你預約嗎？"',
  );
  await sleep(STEP_DELAY_MS);
  await send(
    '5b. 確認 (Cantonese)',
    '好 book啦',
    '[CONTEXT USED] → "Booking created" → reply "完成 👍 已幫你預約星期五晚上9–10點 🏀"',
  );

  console.log('\n[FLOW] ✅ All messages sent. Review the server logs above.');
  console.log(
    '[FLOW] Note: WhatsApp send may log 401 until WHATSAPP_TOKEN is refreshed;',
  );
  console.log('[FLOW]       the internal pipeline + calendar + Firestore still run.');
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(
    '[ERROR]',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
