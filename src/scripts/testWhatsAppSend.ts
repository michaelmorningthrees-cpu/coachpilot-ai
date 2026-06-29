/**
 * Standalone WhatsApp Cloud API send test.
 *
 * Sends a single text message to TEST_PHONE_NUMBER to verify credentials and
 * connectivity. Self-contained: does NOT touch the webhook, AI, or calendar.
 *
 * Run with:  npx ts-node src/scripts/testWhatsAppSend.ts
 *       or:  npm run test:whatsapp
 *
 * Required env:
 *   - WHATSAPP_TOKEN
 *   - WHATSAPP_PHONE_NUMBER_ID
 *   - TEST_PHONE_NUMBER   (recipient, international format e.g. 85291234567)
 *   - WHATSAPP_API_VERSION (optional, defaults to v22.0)
 */

import dotenv from 'dotenv';

dotenv.config();

const API_VERSION = process.env.WHATSAPP_API_VERSION ?? 'v22.0';
const TEST_PHONE = process.env.TEST_PHONE_NUMBER;
const TEST_MESSAGE = '🎉 CoachPilot AI is connected successfully!';

async function sendWhatsAppMessage(to: string, message: string): Promise<void> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.error(
      'Failed: missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID in .env',
    );
    process.exit(1);
  }

  const url = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;

  console.log('Sending...');
  console.log(`To: ${to}`);
  console.log(`Message: "${message}"`);

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

  const body = await response.text();
  console.log('Meta response:', body);

  if (response.ok) {
    console.log('Success ✅');
  } else {
    console.log(`Failed ❌ (status ${response.status})`);
    process.exit(1);
  }
}

if (!TEST_PHONE) {
  console.error('Failed: TEST_PHONE_NUMBER is not set in .env');
  process.exit(1);
}

sendWhatsAppMessage(TEST_PHONE, TEST_MESSAGE).catch((error: unknown) => {
  console.error(
    'Failed ❌',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
