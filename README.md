# CoachPilot AI

A lightweight WhatsApp booking assistant for sports coaches. Automates WhatsApp
replies, checks calendar availability, and helps schedule coaching sessions.

> **Status:** Step 1 — WhatsApp Cloud API webhook (verification + message receiving) only.
> AI intent detection and Google Calendar integration come in later steps.

## Tech Stack

- Node.js + TypeScript
- Express.js
- dotenv

## Project Structure

```
src/
  app.ts                      # Server entry point
  routes/webhook.ts           # Route definitions
  controllers/webhookController.ts  # Request handlers
  services/logger.ts          # Centralised console logger
  utils/validateWebhook.ts    # Verification + payload parsing helpers
  types/whatsapp.ts           # WhatsApp Cloud API type definitions
```

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file from the example and fill in your values:

```bash
cp .env.example .env
```

```
PORT=3000
WHATSAPP_VERIFY_TOKEN=your_verify_token_here
```

## Running

Development (auto-reload):

```bash
npm run dev
```

Production build + run:

```bash
npm run build
npm start
```

## Endpoints

### `GET /webhook`

Meta webhook verification handshake. Echoes back `hub.challenge` when
`hub.mode=subscribe` and `hub.verify_token` matches `WHATSAPP_VERIFY_TOKEN`;
otherwise returns `403`.

### `POST /webhook`

Receives WhatsApp events. Safely parses the payload and logs each incoming
text message:

```
[WHATSAPP INCOMING]
From: +123456789
Message: "Hi coach, are you available Wednesday?"
Time: 2026-06-27T12:00:00.000Z
```

Always responds `200` so Meta does not retry, even on malformed payloads.

### `GET /health`

Simple liveness check returning `{ "status": "ok" }`.

## Quick Local Test

```bash
# Verification (replace token with your WHATSAPP_VERIFY_TOKEN)
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=CHALLENGE123"

# Simulate an incoming message
curl -X POST "http://localhost:3000/webhook" \
  -H "Content-Type: application/json" \
  -d '{"object":"whatsapp_business_account","entry":[{"id":"1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","messages":[{"from":"+123456789","id":"wamid.1","timestamp":"1782561600","type":"text","text":{"body":"Hi coach, are you available Wednesday?"}}]}}]}]}'
```
